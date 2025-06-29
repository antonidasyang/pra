const { ipcRenderer } = require('electron');
const axios = require('axios');
const path = require('path');
const marked = require('marked');

// PDF.js 配置 - 使用字符串路径
const pdfjsLib = require('pdfjs-dist');
pdfjsLib.GlobalWorkerOptions.workerSrc = 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs';

class PaperReader {
  constructor() {
    this.currentPdf = null;
    this.currentPage = 1;
    this.totalPages = 0;
    this.currentZoom = 100;
    this.zoomMode = 'fit-width';
    this.fitWidthScale = 1.0;
    this.fitPageScale = 1.0;
    this.selectedText = '';
    this.proxyUrl = '';
    
    // 状态记忆相关属性
    this.lastFilePath = '';
    this.lastPage = 1;
    this.lastZoom = 100;
    this.lastZoomMode = 'fit-width';
    this.lastScrollTop = 0;
    this.scrollTimeout = null;
    
    // 滚轮翻页防抖
    this.wheelTimeout = null;
    
    // 缓存滚动翻页设置，避免每次滚动都读取
    this.enableScrollPageTurn = true;
    
    this.init();
  }

  init() {
    this.loadSettings();
    this.loadAppState(); // 加载应用状态
    this.setupPDFViewer();
    this.bindEvents();
    
    // 检查版本更新
    this.checkVersionUpdate();
    
    // 如果有上次的文件路径，尝试自动加载
    if (this.lastFilePath) {
      this.autoLoadLastFile();
    }
  }

  // 自动加载上次的文件
  async autoLoadLastFile() {
    try {
      // 检查文件是否存在
      const fs = require('fs');
      if (fs.existsSync(this.lastFilePath)) {
        console.log('自动加载上次的文件:', this.lastFilePath);
        
        // 读取文件
        const arrayBuffer = fs.readFileSync(this.lastFilePath);
        
        this.currentPdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        this.totalPages = this.currentPdf.numPages;
        
        // 恢复缩放设置
        this.currentZoom = this.lastZoom;
        this.zoomMode = this.lastZoomMode;
        
        // 显示上次的页面
        await this.showPDFPage(this.lastPage);
        
        // 恢复滚动位置
        setTimeout(() => {
          this.setScrollTop(this.lastScrollTop);
        }, 100);
        
        this.extractOutline();
        this.showMessage('已恢复上次的阅读状态');
        this.updatePageInfo();
        this.updateZoomButtons();
      } else {
        console.log('上次的文件不存在:', this.lastFilePath);
        this.lastFilePath = ''; // 清除无效路径
        this.saveAppState();
      }
    } catch (error) {
      console.error('自动加载文件失败:', error);
      this.lastFilePath = ''; // 清除无效路径
      this.saveAppState();
    }
  }

  bindEvents() {
    document.getElementById('load-pdf').addEventListener('click', () => {
      this.loadPDF();
    });

    document.getElementById('translate-btn').addEventListener('click', () => {
      this.switchToTab('translation');
      this.translateCurrentPage();
    });

    document.getElementById('interpret-btn').addEventListener('click', () => {
      this.switchToTab('interpretation');
      this.interpretCurrentPage();
    });

    // Tab切换事件
    document.getElementById('translation-tab').addEventListener('click', () => {
      this.switchToTab('translation');
    });

    document.getElementById('interpretation-tab').addEventListener('click', () => {
      this.switchToTab('interpretation');
    });

    // 添加页码跳转功能
    document.getElementById('go-to-page').addEventListener('click', () => {
      this.goToPage();
    });

    // 添加回车键跳转功能
    document.getElementById('page-input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        this.goToPage();
      }
    });

    // 添加鼠标滚轮翻页功能
    document.getElementById('pdf-viewer-container').addEventListener('wheel', (e) => {
      this.handleWheelScroll(e);
    });

    // 添加滚动事件监听，保存滚动位置
    document.getElementById('pdf-viewer-container').addEventListener('scroll', () => {
      // 使用防抖，避免频繁保存
      clearTimeout(this.scrollTimeout);
      this.scrollTimeout = setTimeout(() => {
        this.saveAppState();
      }, 500);
    });

    // 添加侧边栏折叠功能
    document.getElementById('toggle-sidebar').addEventListener('click', () => {
      this.toggleSidebar();
    });

    // 设置相关事件
    document.getElementById('settings-btn').addEventListener('click', () => {
      this.showSettings();
    });

    document.getElementById('close-settings').addEventListener('click', () => {
      this.hideSettings();
    });

    document.getElementById('save-settings').addEventListener('click', () => {
      this.saveSettings();
    });

    document.getElementById('test-proxy').addEventListener('click', () => {
      this.testProxy();
    });

    document.getElementById('test-llm').addEventListener('click', () => {
      this.testLLM();
    });

    // 添加窗口大小改变事件监听器
    window.addEventListener('resize', () => {
      if (this.currentPdf && this.currentPage) {
        this.showPDFPage(this.currentPage);
      }
      
      // 延迟更新缩放比例显示
      setTimeout(() => {
        this.updateCurrentZoomDisplay();
      }, 200);
    });

    // 添加分割条拖动功能
    this.setupResizer();

    // 缩放控制相关事件
    document.getElementById('zoom-input').addEventListener('input', (e) => {
      let newZoom = parseInt(e.target.value);
      
      // 如果PDF已加载，应用动态约束
      if (this.currentPdf && this.fitPageScale && this.fitWidthScale) {
        const minZoom = Math.round(this.fitPageScale * 100);
        const maxZoom = Math.round(this.fitWidthScale * 100);
        
        // 限制缩放范围
        newZoom = Math.max(minZoom, Math.min(maxZoom, newZoom));
        
        // 如果值被限制，更新输入框显示
        if (newZoom !== parseInt(e.target.value)) {
          e.target.value = newZoom;
        }
      }
      
      this.currentZoom = newZoom;
      this.zoomMode = 'custom';
      this.updateZoomButtons();
      if (this.currentPdf && this.currentPage) {
        this.showPDFPage(this.currentPage);
      }
      
      // 保存应用状态
      this.saveAppState();
    });

    document.getElementById('zoom-fit-width').addEventListener('click', () => {
      this.zoomMode = 'fit-width';
      this.updateZoomButtons();
      if (this.currentPdf && this.currentPage) {
        this.showPDFPage(this.currentPage);
      }
      
      // 保存应用状态
      this.saveAppState();
    });

    document.getElementById('zoom-fit-page').addEventListener('click', () => {
      this.zoomMode = 'fit-page';
      this.updateZoomButtons();
      if (this.currentPdf && this.currentPage) {
        this.showPDFPage(this.currentPage);
      }
      
      // 保存应用状态
      this.saveAppState();
    });

    // 处理键盘事件
    document.addEventListener('keydown', (e) => {
      this.handleKeyDown(e);
    });

    // 添加翻页箭头事件
    document.getElementById('prev-page').addEventListener('click', () => {
      this.goToPreviousPage();
    });

    document.getElementById('next-page').addEventListener('click', () => {
      this.goToNextPage();
    });
  }

  handleWheelScroll(e) {
    try {
      if (!this.currentPdf) return;

      // 按住Ctrl键时，滚轮用于缩放
      if (e.ctrlKey) {
        e.preventDefault();
        
        // 使用保存的适应宽度和适应页面的缩放比例
        const fitWidthScale = this.fitWidthScale;
        const fitPageScale = this.fitPageScale;
        
        // 向上滚动放大，向下滚动缩小
        const zoomStep = 10; // 每次缩放10%
        if (e.deltaY < 0) {
          // 向上滚动，放大
          const newZoom = this.currentZoom + zoomStep;
          const maxZoom = Math.round(fitWidthScale * 100);
          this.currentZoom = Math.min(maxZoom, newZoom);
        } else {
          // 向下滚动，缩小
          const newZoom = this.currentZoom - zoomStep;
          const minZoom = Math.round(fitPageScale * 100);
          this.currentZoom = Math.max(minZoom, newZoom);
        }
        
        // 切换到自定义模式并更新页面
        this.zoomMode = 'custom';
        this.updateZoomButtons();
        this.showPDFPage(this.currentPage);
      } else {
        // 不按Ctrl键时，检查是否需要滚动或翻页
        const container = document.getElementById('pdf-viewer-container');
        const hasVerticalScrollbar = container.scrollHeight > container.clientHeight;
        
        if (hasVerticalScrollbar) {
          // 有滚动条时，检查是否已滚动到顶部或底部
          const isAtTop = container.scrollTop <= 0;
          const isAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 1;
          
          // 检查是否启用了滚动翻页功能
          if (this.enableScrollPageTurn && ((e.deltaY < 0 && isAtTop) || (e.deltaY > 0 && isAtBottom))) {
            // 在顶部向上滚动或在底部向下滚动时，进行翻页
            e.preventDefault();
            if (e.deltaY > 0) {
              // 向下滚动，翻到下一页
              if (this.currentPage < this.totalPages) {
                this.showPDFPage(this.currentPage + 1);
              }
            } else {
              // 向上滚动，翻到上一页
              if (this.currentPage > 1) {
                this.showPDFPage(this.currentPage - 1);
              }
            }
          }
          // 其他情况下不阻止默认行为，让浏览器处理滚动
        } else {
          // 没有滚动条时，检查是否启用滚动翻页功能
          if (this.enableScrollPageTurn) {
            // 直接翻页
            e.preventDefault();
            
            // 添加防抖机制，避免过快翻页
            if (this.wheelTimeout) {
              return;
            }
            
            this.wheelTimeout = setTimeout(() => {
              this.wheelTimeout = null;
            }, 150); // 150ms防抖间隔
            
            if (e.deltaY > 0) {
              // 向下滚动，翻到下一页
              if (this.currentPage < this.totalPages) {
                this.showPDFPage(this.currentPage + 1);
              }
            } else {
              // 向上滚动，翻到上一页
              if (this.currentPage > 1) {
                this.showPDFPage(this.currentPage - 1);
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('滚轮处理时出错:', error);
      // 显示错误信息到翻译区域，但不阻断正常功能
      const container = document.getElementById('translation-content');
      if (container) {
        container.innerHTML = `<div class="error">页面渲染出错: ${error.message}</div>`;
      }
    }
  }

  // 添加翻页方法
  goToPreviousPage() {
    if (this.currentPdf && this.currentPage > 1) {
      this.showPDFPage(this.currentPage - 1);
    }
  }

  goToNextPage() {
    if (this.currentPdf && this.currentPage < this.totalPages) {
      this.showPDFPage(this.currentPage + 1);
    }
  }

  // 处理键盘事件
  handleKeyDown(e) {
    if (!this.currentPdf) return;

    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        this.goToPreviousPage();
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.goToNextPage();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.handleVerticalScroll('up');
        break;
      case 'ArrowDown':
        e.preventDefault();
        this.handleVerticalScroll('down');
        break;
    }
  }

  // 处理垂直滚动
  handleVerticalScroll(direction) {
    const container = document.getElementById('pdf-viewer-container');
    const currentScale = this.currentZoom / 100;
    const fitPageScale = this.fitPageScale;
    
    // 如果缩放比例大于适应页面，操作滚动条
    if (currentScale > fitPageScale) {
      const scrollStep = 50; // 每次滚动50像素
      if (direction === 'up') {
        container.scrollTop -= scrollStep;
      } else {
        container.scrollTop += scrollStep;
      }
    } else {
      // 如果缩放比例小于等于适应页面，上下箭头也用于翻页
      if (direction === 'up') {
        this.goToPreviousPage();
      } else {
        this.goToNextPage();
      }
    }
  }

  // 更新翻页箭头状态
  updatePageArrows() {
    const prevBtn = document.getElementById('prev-page');
    const nextBtn = document.getElementById('next-page');
    
    if (prevBtn && nextBtn) {
      // 第一页时左边箭头置灰
      prevBtn.disabled = this.currentPage <= 1;
      prevBtn.style.opacity = this.currentPage <= 1 ? '0.5' : '1';
      prevBtn.style.cursor = this.currentPage <= 1 ? 'not-allowed' : 'pointer';
      
      // 最后一页时右边箭头置灰
      nextBtn.disabled = this.currentPage >= this.totalPages;
      nextBtn.style.opacity = this.currentPage >= this.totalPages ? '0.5' : '1';
      nextBtn.style.cursor = this.currentPage >= this.totalPages ? 'not-allowed' : 'pointer';
    }
  }

  updateZoomButtons() {
    const fitWidthBtn = document.getElementById('zoom-fit-width');
    const fitPageBtn = document.getElementById('zoom-fit-page');
    const zoomInput = document.getElementById('zoom-input');
    
    // 移除所有active类
    fitWidthBtn.classList.remove('active');
    fitPageBtn.classList.remove('active');
    
    // 根据当前模式设置active类
    if (this.zoomMode === 'fit-width') {
      fitWidthBtn.classList.add('active');
    } else if (this.zoomMode === 'fit-page') {
      fitPageBtn.classList.add('active');
    }
    
    // 更新输入框的值和约束
    zoomInput.value = this.currentZoom;
    
    // 如果PDF已加载，动态更新输入框的min和max属性
    if (this.currentPdf && this.fitPageScale && this.fitWidthScale) {
      const minZoom = Math.round(this.fitPageScale * 100);
      const maxZoom = Math.round(this.fitWidthScale * 100);
      zoomInput.min = minZoom;
      zoomInput.max = maxZoom;
    }
  }

  goToPage() {
    if (!this.currentPdf) return;

    const pageInput = document.getElementById('page-input');
    const targetPage = parseInt(pageInput.value);
    
    if (targetPage >= 1 && targetPage <= this.totalPages) {
      this.showPDFPage(targetPage);
    } else {
      this.showError(`页码无效，请输入1-${this.totalPages}之间的数字`);
    }
  }

  updatePageInfo() {
    document.getElementById('page-input').value = this.currentPage;
    document.getElementById('total-pages').textContent = this.totalPages;
    this.updatePageArrows();
  }

  setupPDFViewer() {
    const container = document.getElementById('pdf-viewer-container');
    container.innerHTML = '<div class="loading" style="color: #ecf0f1; text-align: center; padding: 40px;">请选择PDF文件</div>';
  }

  async loadPDF() {
    try {
      // 使用Electron的文件对话框
      const { dialog } = require('@electron/remote');
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
          { name: 'PDF文件', extensions: ['pdf'] }
        ]
      });

      if (!result.canceled && result.filePaths.length > 0) {
        const filePath = result.filePaths[0];
        const fileName = filePath.split(/[\\/]/).pop(); // 获取文件名
        
        // 保存文件路径
        this.lastFilePath = filePath;
        
        // 读取文件
        const fs = require('fs');
        const arrayBuffer = fs.readFileSync(filePath);
        
        this.currentPdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        
        this.totalPages = this.currentPdf.numPages;
        this.showPDFPage(1);
        this.extractOutline();
        this.showMessage('PDF加载成功');
        this.updatePageInfo();
        
        // 保存应用状态
        this.saveAppState();
      }
    } catch (error) {
      console.error('PDF加载错误:', error);
      this.showError('PDF加载失败: ' + error.message);
    }
  }

  async showPDFPage(pageNumber) {
    if (!this.currentPdf) return;

    try {
      const page = await this.currentPdf.getPage(pageNumber);
      
      // 获取容器尺寸
      const container = document.getElementById('pdf-viewer-container');
      const containerWidth = container.clientWidth - 40; // 减去左右padding
      const containerHeight = container.clientHeight - 40; // 减去padding
      
      // 获取页面的原始尺寸
      const originalViewport = page.getViewport({ scale: 1.0 });
      
      let scale;
      
      // 计算适应宽度和适应页面的缩放比例（用于滚轮缩放限制）
      const scaleX = containerWidth / originalViewport.width;
      const scaleY = containerHeight / originalViewport.height;
      this.fitWidthScale = scaleX; // 适应宽度的缩放比例
      this.fitPageScale = Math.min(scaleX, scaleY); // 适应页面的缩放比例 - 等比例缩放，完全适应容器
      
      // 根据缩放模式计算缩放比例
      switch (this.zoomMode) {
        case 'fit-width':
          // 适应宽度
          scale = this.fitWidthScale;
          break;
        case 'fit-page':
          // 适应页面（等比例缩放，完全适应容器）
          scale = this.fitPageScale; // 使用已经计算好的适应页面缩放比例
          break;
        case 'custom':
          // 自定义百分比
          scale = this.currentZoom / 100;
          break;
        default:
          scale = this.fitWidthScale;
      }
      
      // 限制缩放范围
      scale = Math.max(0.25, Math.min(4.0, scale));
      
      // 只在非自定义模式下更新当前缩放值
      if (this.zoomMode !== 'custom') {
        this.currentZoom = Math.round(scale * 100);
      }
      
      // 使用计算出的缩放比例创建视口
      const viewport = page.getViewport({ scale: scale });
      
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      
      // 设置canvas样式
      canvas.style.background = 'white';
      canvas.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.3), 0 8px 40px rgba(0, 0, 0, 0.2)';
      canvas.style.borderRadius = '2px';
      
      // 根据缩放模式设置canvas尺寸
      if (this.zoomMode === 'fit-page') {
        // 适应页面模式：等比例缩放，完全适应容器
        canvas.style.maxWidth = '100%';
        canvas.style.maxHeight = '100%';
        canvas.style.width = 'auto';
        canvas.style.height = 'auto';
      } else {
        // 其他模式：保持原有逻辑
        canvas.style.maxWidth = '100%';
        canvas.style.height = 'auto';
      }

      const renderContext = {
        canvasContext: context,
        viewport: viewport
      };

      await page.render(renderContext).promise;
      
      container.innerHTML = '';
      container.appendChild(canvas);
      
      // 在页面渲染完成后立即进行段落拼接
      await this.processPageText(page, viewport);
      
      // 添加文本选择功能
      this.addTextSelectionSupport(canvas, page, viewport);
      
      this.currentPage = pageNumber;
      this.updatePageInfo();
      this.updateZoomButtons();
      this.updatePageArrows();
      
      // 保存应用状态
      this.saveAppState();
    } catch (error) {
      this.showError('页面渲染失败: ' + error.message);
    }
  }

  // 新增方法：处理页面文本内容并拼接段落
  async processPageText(page, viewport) {
    try {
      const textContent = await page.getTextContent();

      // 第一步：过滤和排序文本片段
      const sortedItems = [];
      textContent.items.forEach(item => {
        if (item.str.trim() !== '' && item.width > 0 && item.height > 0) {
          let isInserted = false;
          for (let i = 0; i < sortedItems.length; i++) {
            const sortedItem = sortedItems[i];
            if (item.transform[5] > sortedItem.transform[5]) {
              sortedItems.splice(i, 0, item);
              isInserted = true;
              break;
            } else if (Math.abs(item.transform[5] - sortedItem.transform[5]) < 1) {
              if (item.transform[4] < sortedItem.transform[4]) {
                sortedItems.splice(i, 0, item);
                isInserted = true;
                break;
              }
            }
          }

          if (!isInserted) {
            sortedItems.push(item);
          }
        }
      });
      
      // 第二步：拼行句
      const lines = [];
      let currentLine = '';
      let currentLineY = null;
      let currentLineHeight = 0;
      
      sortedItems.forEach(item => {
        const itemY = item.transform[5];
        const itemHeight = item.height;
        
        if (currentLineY === null) {
          // 第一行
          currentLine = item.str;
          currentLineY = itemY;
          currentLineHeight = itemHeight;
        } else if (Math.abs(itemY - currentLineY) < 1) {
          // 同一行，直接拼接
          currentLine += item.str;
          currentLineHeight = Math.max(currentLineHeight, itemHeight);
        } else {
          // 新行，保存当前行并开始新行
          if (currentLine.trim()) {
            lines.push({
              text: currentLine.trim(),
              y: currentLineY,
              height: currentLineHeight
            });
          }
          currentLine = item.str;
          currentLineY = itemY;
          currentLineHeight = itemHeight;
        }
      });
      
      // 添加最后一行
      if (currentLine.trim()) {
        lines.push({
          text: currentLine.trim(),
          y: currentLineY,
          height: currentLineHeight
        });
      }
      
      // 第三步：拼段落
      const paragraphs = [];
      let currentParagraph = '';
      let lastLineY = null;
      let lastLineHeight = 0;
      
      lines.forEach(line => {
        let isNewParagraph = false;
        
        if (lastLineY !== null) {
          const spacing = Math.abs(line.y - lastLineY);
          const threshold = Math.min(lastLineHeight, line.height) * 1.5;
          if (spacing > threshold) {
            isNewParagraph = true;
          }
        }
        
        if (isNewParagraph && currentParagraph.trim()) {
          // 结束当前段落
          paragraphs.push(currentParagraph.trim());
          currentParagraph = line.text;
        } else {
          // 继续当前段落
          if (currentParagraph) {
            currentParagraph += ' ' + line.text;
          } else {
            currentParagraph = line.text;
          }
        }
        
        lastLineY = line.y;
        lastLineHeight = line.height;
      });
      
      // 添加最后一个段落
      if (currentParagraph.trim()) {
        paragraphs.push(currentParagraph.trim());
      }

      // 存储处理后的段落和文本内容
      this.currentPageParagraphs = paragraphs;
      this.currentPageTextContent = textContent;
      this.currentPageViewport = viewport;
      
      console.log('页面文本处理完成，段落数量:', paragraphs.length);
    } catch (error) {
      console.error('处理页面文本失败:', error);
    }
  }

  async translateCurrentPage() {
    if (!this.currentPdf) {
      this.showError('请先加载PDF文件');
      return;
    }

    if (!this.currentPageParagraphs || this.currentPageParagraphs.length === 0) {
      this.showError('当前页面没有可翻译的文本内容');
      return;
    }

    try {
      // 使用预先处理好的段落
      const paragraphs = this.currentPageParagraphs;
      
      console.log('开始翻译，段落数量:', paragraphs.length);
      paragraphs.forEach((paragraph, index) => {
        console.log(`[${index}] 段落: "${paragraph}"`);
      });
      
      // 开始翻译
      await this.translateText(paragraphs);
    } catch (error) {
      this.showError('翻译失败: ' + error.message);
    }
  }

  async translateText(paragraphs) {
    try {
      const container = document.getElementById('translation-content');
      
      // 创建骨架框占位符
      let skeletonHtml = '<div class="translated-text">';
      for (let i = 0; i < paragraphs.length; i++) {
        if (paragraphs[i].trim()) {
          skeletonHtml += `
            <div class="skeleton-placeholder" id="placeholder-${i}">
              <div class="loading-dots">
                <div></div>
                <div></div>
                <div></div>
              </div>
            </div>
          `;
        }
      }
      skeletonHtml += '</div>';
      
      // 显示骨架框
      container.innerHTML = skeletonHtml;
      
      // 逐个翻译段落
      for (let i = 0; i < paragraphs.length; i++) {
        const paragraph = paragraphs[i];
        if (paragraph.trim()) {
          try {
            const response = await axios.get('https://translate.googleapis.com/translate_a/single', {
              params: {
                client: 'gtx',
                sl: 'en',
                tl: 'zh-CN',
                dt: 't',
                q: paragraph
              },
              timeout: 5000
            });

            if (response.data && response.data[0]) {
              const translation = response.data[0].map(item => item[0]).join('');
              
              // 只替换对应的占位符
              const placeholder = document.getElementById(`placeholder-${i}`);
              if (placeholder) {
                placeholder.outerHTML = `<p>${translation}</p>`;
              }
            }
          } catch (error) {
            console.error(`翻译第${i + 1}段时出错:`, error);
            // 翻译失败时显示原文
            const placeholder = document.getElementById(`placeholder-${i}`);
            if (placeholder) {
              placeholder.outerHTML = `<p class="translation-error">翻译失败，显示原文: ${paragraph}</p>`;
            }
          }
        }
      }
      
      return container.innerHTML;
    } catch (error) {
      console.error('翻译API错误:', error);
      throw new Error('翻译服务暂时不可用，请稍后重试');
    }
  }

  displayTranslation(translation) {
    const container = document.getElementById('translation-content');
    container.innerHTML = translation;
  }

  showMessage(message) {
    const container = document.getElementById('translation-content');
    container.innerHTML = `<div class="loading">${message}</div>`;
  }

  showError(message) {
    const container = document.getElementById('translation-content');
    container.innerHTML = `<div class="error">${message}</div>`;
  }

  showSettings() {
    // 加载当前设置到表单
    const settings = this.loadSettings();
    document.getElementById('proxy-url').value = settings.proxyUrl || '';
    document.getElementById('llm-url').value = settings.llmUrl || '';
    document.getElementById('llm-model').value = settings.llmModel || '';
    document.getElementById('llm-api-key').value = settings.llmApiKey || '';
    document.getElementById('interpretation-prompt').value = settings.interpretationPrompt || '';
    document.getElementById('enable-scroll-page-turn').checked = settings.enableScrollPageTurn !== false; // 默认为true
    
    // 显示版本号
    const packageJson = require('./package.json');
    document.getElementById('settings-version').textContent = `v${packageJson.version}`;
    
    document.getElementById('settings-modal').style.display = 'flex';
  }

  hideSettings() {
    document.getElementById('settings-modal').style.display = 'none';
  }

  saveSettings() {
    const settings = {
      proxyUrl: document.getElementById('proxy-url').value.trim(),
      llmUrl: document.getElementById('llm-url').value.trim(),
      llmModel: document.getElementById('llm-model').value.trim(),
      llmApiKey: document.getElementById('llm-api-key').value.trim(),
      interpretationPrompt: document.getElementById('interpretation-prompt').value.trim(),
      enableScrollPageTurn: document.getElementById('enable-scroll-page-turn').checked
    };
    
    // 保存到localStorage
    localStorage.setItem('settings', JSON.stringify(settings));
    
    // 更新缓存的设置
    this.enableScrollPageTurn = settings.enableScrollPageTurn;
    
    // 设置全局代理
    if (settings.proxyUrl) {
      ipcRenderer.send('set-global-proxy', { proxyUrl: settings.proxyUrl });
    } else {
      ipcRenderer.send('clear-global-proxy');
    }
    
    this.hideSettings();
    this.showMessage('设置已保存');
  }

  loadSettings() {
    try {
      const settingsStr = localStorage.getItem('settings');
      if (settingsStr) {
        const settings = JSON.parse(settingsStr);
        this.proxyUrl = settings.proxyUrl || '';
        this.llmUrl = settings.llmUrl || '';
        this.llmModel = settings.llmModel || '';
        this.llmApiKey = settings.llmApiKey || '';
        this.interpretationPrompt = settings.interpretationPrompt || '';
        this.enableScrollPageTurn = settings.enableScrollPageTurn !== false; // 缓存设置，默认为true
        
        // 加载时设置全局代理
        if (this.proxyUrl) {
          ipcRenderer.send('set-global-proxy', { proxyUrl: this.proxyUrl });
        }
        
        return settings;
      }
    } catch (error) {
      console.error('加载设置失败:', error);
    }
    
    // 默认设置
    return {
      proxyUrl: '',
      llmUrl: 'https://api.openai.com/v1/chat/completions',
      llmModel: 'gpt-3.5-turbo',
      llmApiKey: '',
      interpretationPrompt: `请对以下学术论文内容进行专业解读，包括：
1. 主要内容概述
2. 研究方法分析
3. 关键发现和结论
4. 学术价值和意义
5. 可能的局限性和改进方向

论文内容：
{text}

请用中文回答，格式要清晰易读。`,
      enableScrollPageTurn: true
    };
  }

  async testProxy() {
    const proxyUrl = document.getElementById('proxy-url').value.trim();
    if (!proxyUrl) {
      this.showError('请输入代理地址');
      return;
    }

    try {
      // 先设置全局代理
      ipcRenderer.send('set-global-proxy', { proxyUrl });
      
      // 等待代理设置完成，添加超时
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('代理设置超时'));
        }, 3000);
        
        ipcRenderer.once('proxy-set', (event, result) => {
          clearTimeout(timeout);
          if (result.success) {
            resolve();
          } else {
            reject(new Error(result.error));
          }
        });
      });
      
      // 然后测试翻译
      const response = await axios.get('https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=test', {
        timeout: 5000
      });
      
      this.showMessage('代理测试成功');
    } catch (error) {
      console.error('代理测试详细错误:', error);
      this.showError('代理测试失败: ' + error.message);
    }
  }

  toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('toggle-sidebar');
    
    // 检查当前状态
    const isCollapsed = sidebar.classList.contains('collapsed');
    
    if (isCollapsed) {
      // 展开大纲
      sidebar.classList.remove('collapsed');
      toggleBtn.textContent = '←';
    } else {
      // 折叠大纲
      sidebar.classList.add('collapsed');
      toggleBtn.textContent = '☰';
    }
    
    // 在动画过程中持续重绘高亮
    const animationDuration = 300; // 与CSS过渡时间一致
    const interval = 16; // 约60fps
    const steps = Math.ceil(animationDuration / interval);
    let currentStep = 0;
    
    const animateHighlights = () => {
      if (currentStep < steps) {
        // 重新计算高亮框位置
        if (this.recalculateHighlights) {
          this.recalculateHighlights();
        }
        currentStep++;
        setTimeout(animateHighlights, interval);
      } else {
        // 动画结束，最后重绘一次
        if (this.recalculateHighlights) {
          this.recalculateHighlights();
        }
      }
    };
    
    // 开始动画
    animateHighlights();
  }

  async extractOutline() {
    try {
      const outline = await this.currentPdf.getOutline();
      this.displayOutline(outline);
    } catch (error) {
      this.displayOutline([]);
    }
  }

  displayOutline(outline) {
    const container = document.getElementById('outline-content');
    
    if (!outline || outline.length === 0) {
      container.innerHTML = '<div class="loading">该PDF没有大纲信息</div>';
      return;
    }

    const outlineHtml = outline.map(item => {
      const pageNumber = this.getPageNumberFromDest(item.dest);
      return `
        <div class="outline-item" data-page="${pageNumber}">
          <div class="title">${item.title}</div>
          <div class="page">第 ${pageNumber} 页</div>
        </div>
      `;
    }).join('');

    container.innerHTML = outlineHtml;

    // 添加大纲项点击事件
    container.querySelectorAll('.outline-item').forEach(item => {
      item.addEventListener('click', () => {
        const pageNumber = parseInt(item.dataset.page);
        if (pageNumber && pageNumber > 0) {
          this.showPDFPage(pageNumber);
        }
      });
    });
  }

  getPageNumberFromDest(dest) {
    if (dest && dest.ref) {
      const pageRef = this.currentPdf.getPageIndex(dest.ref);
      if (pageRef !== -1) {
        return pageRef + 1;
      }
    }
    return 1;
  }

  // 获取选择范围内的文本项
  getItemsInRange(startItem, endItem, textContent) {
    const items = [];
    const startIndex = textContent.items.indexOf(startItem);
    const endIndex = textContent.items.indexOf(endItem);
    
    const minIndex = Math.min(startIndex, endIndex);
    const maxIndex = Math.max(startIndex, endIndex);
    
    // 以原始文本块为最小选择单位，直接选择范围内的所有文本项
    for (let i = minIndex; i <= maxIndex; i++) {
      items.push(textContent.items[i]);
    }
    
    return items;
  }

  // 获取同一行的文本项
  getItemsInSameLine(item, textContent) {
    if (!item || !textContent) return [];
    
    const items = [];
    const itemY = item.transform[5];
    const tolerance = 2; // 容差，用于判断是否在同一行
    
    textContent.items.forEach(textItem => {
      const textItemY = textItem.transform[5];
      if (Math.abs(textItemY - itemY) <= tolerance) {
        items.push(textItem);
      }
    });
    
    // 按X坐标排序
    items.sort((a, b) => a.transform[4] - b.transform[4]);
    
    return items;
  }

  // 清除选择
  clearSelection() {
    const overlays = document.querySelectorAll('.text-selection-overlay');
    overlays.forEach(overlay => {
      if (overlay.parentElement) {
        overlay.parentElement.removeChild(overlay);
      }
    });
    
    // 清除本地数组中的引用
    if (this.currentSelectionOverlays) {
      this.currentSelectionOverlays.length = 0;
    }
  }

  addTextSelectionSupport(canvas, page, viewport) {
    let isSelecting = false;
    let startItem = null;
    let endItem = null;
    let textContent = null;
    let selectionOverlays = [];
    
    // 将selectionOverlays保存到实例中，以便clearSelection方法可以访问
    this.currentSelectionOverlays = selectionOverlays;
    
    // 设置canvas的鼠标样式为文本选择样式
    canvas.style.cursor = 'text';
    
    // 预加载文本内容
    page.getTextContent().then(content => {
      textContent = content;
    });
    
    // 获取鼠标位置对应的文本项
    const getTextItemAtPosition = (mouseX, mouseY) => {
      if (!textContent) return null;
      
      // 获取canvas的实际显示尺寸
      const canvasRect = canvas.getBoundingClientRect();
      
      // 计算实际缩放比例
      const scaleX = canvasRect.width / canvas.width;
      const scaleY = canvasRect.height / canvas.height;
      
      // 使用实际缩放比例转换坐标
      const pdfX = mouseX / (viewport.scale * scaleX);
      // PDF坐标系Y轴向上，Canvas坐标系Y轴向下，需要转换
      const pdfY = (canvasRect.height - mouseY) / (viewport.scale * scaleY);
      
      // 找到最接近的文本项
      let closestItem = null;
      let minDistance = Infinity;
      
      textContent.items.forEach(item => {
        const itemX = item.transform[4];
        const itemY = item.transform[5];
        const itemWidth = item.width;
        const itemHeight = item.height;
        
        // 检查鼠标是否在文本项范围内
        if (pdfX >= itemX && pdfX <= itemX + itemWidth &&
            pdfY >= itemY && pdfY <= itemY + itemHeight) {
          const distance = Math.sqrt(
            Math.pow(pdfX - (itemX + itemWidth/2), 2) + 
            Math.pow(pdfY - (itemY + itemHeight/2), 2)
          );
          
          if (distance < minDistance) {
            minDistance = distance;
            closestItem = item;
          }
        }
      });
      
      return closestItem;
    };
    
    // 创建文本项高亮
    const createTextHighlight = (item, color = 'rgba(255, 193, 7, 0.3)') => {
      const overlay = document.createElement('div');
      overlay.style.position = 'absolute';
      overlay.style.backgroundColor = color;
      overlay.style.border = `1px solid ${color.replace('0.3', '0.5')}`;
      overlay.style.borderRadius = '2px';
      overlay.style.pointerEvents = 'none';
      overlay.style.zIndex = '5';
      
      // 获取canvas的实际显示尺寸和位置
      const canvasRect = canvas.getBoundingClientRect();
      const containerRect = canvas.parentElement.getBoundingClientRect();
      
      // 获取容器的滚动偏移量
      const container = canvas.parentElement;
      const scrollLeft = container.scrollLeft || 0;
      const scrollTop = container.scrollTop || 0;
      
      // 计算实际缩放比例
      const scaleX = canvasRect.width / canvas.width;
      const scaleY = canvasRect.height / canvas.height;
      
      // 计算PDF坐标在canvas上的位置
      const itemX = item.transform[4] * viewport.scale * scaleX;
      const itemY = item.transform[5] * viewport.scale * scaleY;
      const itemWidth = item.width * viewport.scale * scaleX;
      const itemHeight = item.height * viewport.scale * scaleY;
      
      // PDF坐标系：原点在左下角，Y轴向上
      // Canvas坐标系：原点在左上角，Y轴向下
      // 需要将PDF的Y坐标转换为Canvas的Y坐标
      const canvasY = canvasRect.height - itemY - itemHeight;
      
      // 计算相对于容器的位置，并减去滚动偏移量
      // 因为高亮框是相对于容器定位的，而容器有滚动，所以需要减去滚动偏移量
      const relativeX = itemX + canvas.offsetLeft - scrollLeft;
      const relativeY = canvasY + canvas.offsetTop - scrollTop;
      
      // 添加调试信息
      console.log('高亮框位置调试:', {
        itemTransform: item.transform,
        viewportScale: viewport.scale,
        scaleX, scaleY,
        itemX, itemY, itemWidth, itemHeight,
        canvasY,
        canvasOffset: { left: canvas.offsetLeft, top: canvas.offsetTop },
        containerRect: { left: containerRect.left, top: containerRect.top, width: containerRect.width, height: containerRect.height },
        scrollOffset: { left: scrollLeft, top: scrollTop },
        relativeX, relativeY
      });
      
      overlay.style.left = relativeX + 'px';
      overlay.style.top = relativeY + 'px';
      overlay.style.width = itemWidth + 'px';
      overlay.style.height = itemHeight + 'px';
      
      return overlay;
    };
    
    // 重新计算所有高亮框的位置和大小
    const recalculateHighlights = () => {
      if (!startItem || !endItem || !textContent || selectionOverlays.length === 0) return;
      
      // 清除当前高亮
      this.clearSelection();
      
      // 重新创建高亮
      const selectedItems = this.getItemsInRange(startItem, endItem, textContent);
      selectedItems.forEach(item => {
        const highlight = createTextHighlight(item);
        highlight.classList.add('text-selection-overlay');
        canvas.parentElement.appendChild(highlight);
        selectionOverlays.push(highlight);
      });
    };
    
    // 将recalculateHighlights方法保存到实例中，以便外部调用
    this.recalculateHighlights = recalculateHighlights;
    
    // 鼠标按下事件 - 只用于取消选择
    canvas.addEventListener('mousedown', (e) => {
      e.preventDefault();
      
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      const clickedItem = getTextItemAtPosition(mouseX, mouseY);
      
      // 如果点击了空白区域，清除选择
      if (!clickedItem) {
        this.clearSelection();
        startItem = null;
        endItem = null;
        isSelecting = false;
        return;
      }
      
      // 如果已经有选择，清除选择（无论点击的是否是已选择的区域）
      if (startItem && endItem && selectionOverlays.length > 0) {
        this.clearSelection();
        startItem = null;
        endItem = null;
        isSelecting = false;
        return;
      }
    });
    
    // 鼠标移动事件
    canvas.addEventListener('mousemove', (e) => {
      // 如果没有按下鼠标，不处理移动事件
      if (!e.buttons || e.buttons === 0) return;
      
      // 如果还没有开始选择，开始选择
      if (!isSelecting) {
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        const startClickedItem = getTextItemAtPosition(mouseX, mouseY);
        if (startClickedItem) {
          isSelecting = true;
          canvas.style.cursor = 'text';
          startItem = startClickedItem;
          
          // 创建初始高亮
          const highlight = createTextHighlight(startItem, 'rgba(0, 123, 255, 0.3)');
          highlight.classList.add('text-selection-overlay');
          canvas.parentElement.appendChild(highlight);
          selectionOverlays.push(highlight);
        }
      }
      
      // 如果正在选择，继续处理
      if (!isSelecting || !startItem) return;
      e.preventDefault();
      
      // 保持鼠标样式为文本选择样式
      canvas.style.cursor = 'text';
      
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      const currentItem = getTextItemAtPosition(mouseX, mouseY);
      
      if (currentItem && currentItem !== endItem) {
        endItem = currentItem;
        
        this.clearSelection();
        
        if (startItem && endItem) {
          const selectedItems = this.getItemsInRange(startItem, endItem, textContent);
          selectedItems.forEach(item => {
            const highlight = createTextHighlight(item, 'rgba(0, 123, 255, 0.3)');
            highlight.classList.add('text-selection-overlay');
            canvas.parentElement.appendChild(highlight);
            selectionOverlays.push(highlight);
          });
        }
      }
    });
    
    // 鼠标松开事件
    canvas.addEventListener('mouseup', (e) => {
      if (isSelecting) {
        e.preventDefault();
        isSelecting = false;
        
        // 重新计算高亮并触发翻译
        if (startItem && endItem && textContent) {
          // 清除当前高亮
          this.clearSelection();
          
          // 重新创建高亮
          const selectedItems = this.getItemsInRange(startItem, endItem, textContent);
          selectedItems.forEach(item => {
            const highlight = createTextHighlight(item);
            highlight.classList.add('text-selection-overlay');
            canvas.parentElement.appendChild(highlight);
            selectionOverlays.push(highlight);
          });
          
          // 获取选中文本并翻译
          const selectedText = selectedItems.map(item => item.str).join(' ');
          if (selectedText.trim()) {
            this.translateSelectedText(selectedText);
          }
        }
        
        // 保持鼠标样式为文本选择样式
        canvas.style.cursor = 'text';
      }
    });
    
    // 双击选择整行
    canvas.addEventListener('dblclick', (e) => {
      e.preventDefault();
      
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      const clickedItem = getTextItemAtPosition(mouseX, mouseY);
      
      if (clickedItem) {
        // 清除之前的选择
        this.clearSelection();
        
        // 获取同一行的所有文本项
        const lineItems = this.getItemsInSameLine(clickedItem, textContent);
        
        if (lineItems.length > 0) {
          // 设置选择范围
          startItem = lineItems[0];
          endItem = lineItems[lineItems.length - 1];
          
          // 高亮显示整行
          lineItems.forEach(item => {
            const highlight = createTextHighlight(item, 'rgba(255, 193, 7, 0.3)');
            highlight.classList.add('text-selection-overlay');
            canvas.parentElement.appendChild(highlight);
            selectionOverlays.push(highlight);
          });
          
          // 获取选中文本并翻译
          const selectedText = lineItems.map(item => item.str).join(' ');
          if (selectedText.trim()) {
            this.translateSelectedText(selectedText);
          }
        }
      }
    });
    
    // 防止拖拽时选中文本
    canvas.addEventListener('selectstart', (e) => {
      e.preventDefault();
    });
    
    // 防止右键菜单
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
    
    // 鼠标离开canvas区域时恢复默认鼠标样式
    canvas.addEventListener('mouseleave', (e) => {
      if (!isSelecting) {
        canvas.style.cursor = 'default';
      }
    });
    
    // 鼠标进入canvas区域时设置文本选择样式
    canvas.addEventListener('mouseenter', (e) => {
      canvas.style.cursor = 'text';
    });
    
    // 添加滚动事件监听器，当容器滚动时重新计算高亮框位置
    const container = canvas.parentElement;
    if (container) {
      container.addEventListener('scroll', () => {
        // 如果有选中的文本项，重新计算高亮框位置
        if (selectionOverlays.length > 0) {
          // 清除当前高亮
          this.clearSelection();
          
          // 重新创建高亮
          if (startItem && endItem && textContent) {
            const selectedItems = this.getItemsInRange(startItem, endItem, textContent);
            selectedItems.forEach(item => {
              const highlight = createTextHighlight(item);
              highlight.classList.add('text-selection-overlay');
              container.appendChild(highlight);
              selectionOverlays.push(highlight);
            });
          }
        }
      });
    }
  }
  
  async translateSelectedText(selectedText) {
    try {
      const container = document.getElementById('selection-translation-content');
      
      // 显示加载状态
      container.innerHTML = `
        <div class="loading">
          <div class="loading-dots">
            <div></div>
            <div></div>
            <div></div>
          </div>
          <div style="margin-top: 10px; font-size: 12px;">正在翻译选中文本...</div>
        </div>
      `;
      
      const response = await axios.get('https://translate.googleapis.com/translate_a/single', {
        params: {
          client: 'gtx',
          sl: 'en',
          tl: 'zh-CN',
          dt: 't',
          q: selectedText
        },
        timeout: 5000
      });
      
      if (response.data && response.data[0]) {
        const translation = response.data[0].map(item => item[0]).join('');
        
        container.innerHTML = `
          <div class="selected-text-section">
            <div class="translated-text">
              ${translation}
            </div>
          </div>
        `;
      }
    } catch (error) {
      console.error('选择翻译失败:', error);
      const container = document.getElementById('selection-translation-content');
      container.innerHTML = `
        <div class="error">
          翻译失败: ${error.message}
        </div>
      `;
    }
  }

  // 切换Tab页
  switchToTab(tabName) {
    // 移除所有tab按钮的active类
    document.getElementById('translation-tab').classList.remove('active');
    document.getElementById('interpretation-tab').classList.remove('active');
    
    // 隐藏所有tab内容
    document.getElementById('translation-pane').classList.remove('active');
    document.getElementById('interpretation-pane').classList.remove('active');
    
    // 激活对应的tab
    if (tabName === 'translation') {
      document.getElementById('translation-tab').classList.add('active');
      document.getElementById('translation-pane').classList.add('active');
    } else if (tabName === 'interpretation') {
      document.getElementById('interpretation-tab').classList.add('active');
      document.getElementById('interpretation-pane').classList.add('active');
    }
  }

  // 解读当前页面
  async interpretCurrentPage() {
    if (!this.currentPdf || !this.currentPage) {
      this.showError('请先加载PDF文件');
      return;
    }

    try {
      const page = await this.currentPdf.getPage(this.currentPage);
      const viewport = page.getViewport({ scale: 1.0 });
      
      // 获取页面文本内容
      const textContent = await page.getTextContent();
      let fullText = '';
      
      // 拼接所有文本
      textContent.items.forEach(item => {
        fullText += item.str + ' ';
      });
      
      // 清理文本
      fullText = fullText.replace(/\s+/g, ' ').trim();
      
      if (!fullText) {
        this.showError('当前页面没有可解读的文本内容');
        return;
      }

      // 显示加载状态
      const interpretationContent = document.getElementById('interpretation-content');
      interpretationContent.innerHTML = `
        <div class="skeleton-placeholder">
          <div class="loading-dots">
            <div></div>
            <div></div>
            <div></div>
          </div>
          <div style="margin-top: 10px; color: #6c757d;">正在解读论文内容...</div>
        </div>
      `;

      // 获取设置
      const settings = this.loadSettings();
      const { llmUrl, llmModel, llmApiKey, interpretationPrompt } = settings;
      
      if (!llmUrl || !llmModel || !llmApiKey) {
        this.showError('请先在设置中配置大模型信息');
        return;
      }

      // 构建提示词，替换占位符
      const prompt = interpretationPrompt.replace('{text}', fullText);

      // 调用大模型API进行流式解读
      await this.callLLMAPIStream(prompt, llmUrl, llmModel, llmApiKey, interpretationContent);
      
    } catch (error) {
      console.error('解读错误:', error);
      this.showError('解读失败: ' + error.message);
    }
  }

  // 调用大模型API（流式输出）
  async callLLMAPIStream(prompt, llmUrl, llmModel, llmApiKey, contentElement) {
    try {
      // 使用OpenAI Node.js组件
      const OpenAI = require('openai');
      
      const openai = new OpenAI({
        apiKey: llmApiKey,
        baseURL: llmUrl, // 自定义基础URL
        dangerouslyAllowBrowser: true, // 允许在浏览器环境中运行
      });

      // 清空内容区域，准备显示流式输出
      contentElement.innerHTML = '<div style="padding: 20px; line-height: 1.6; font-size: 14px; color: #333;"><div id="stream-content"></div></div>';
      const streamContent = document.getElementById('stream-content');
      
      // 创建流式请求
      const stream = await openai.chat.completions.create({
        model: llmModel,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        stream: true,
        max_tokens: 2000,
        temperature: 0.7
      });

      let fullResponse = '';
      
      // 处理流式响应
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          fullResponse += content;
          // 实时更新显示内容，渲染为markdown
          streamContent.innerHTML = marked.parse(fullResponse);
          // 自动滚动到底部
          contentElement.scrollTop = contentElement.scrollHeight;
        }
      }

      // 流式输出完成后的处理
      if (fullResponse.trim()) {
        // 可以在这里保存完整响应或进行其他处理
        console.log('解读完成，总长度:', fullResponse.length);
      } else {
        streamContent.innerHTML = '<div style="color: #e74c3c;">解读失败：未收到有效响应</div>';
      }

    } catch (error) {
      console.error('流式调用错误:', error);
      contentElement.innerHTML = `<div style="padding: 20px; color: #e74c3c;">解读失败: ${error.message}</div>`;
      throw error;
    }
  }

  // 调用大模型API（非流式，用于测试）
  async callLLMAPI(prompt, llmUrl, llmModel, llmApiKey) {
    try {
      // 使用OpenAI Node.js组件
      const OpenAI = require('openai');
      
      const openai = new OpenAI({
        apiKey: llmApiKey,
        baseURL: llmUrl, // 自定义基础URL
        dangerouslyAllowBrowser: true, // 允许在浏览器环境中运行
      });

      const response = await openai.chat.completions.create({
        model: llmModel,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 2000,
        temperature: 0.7
      });

      return response.choices[0].message.content;
    } catch (error) {
      console.error('大模型调用错误:', error);
      throw error;
    }
  }

  async testLLM() {
    const settings = this.loadSettings();
    const { llmUrl, llmModel, llmApiKey } = settings;
    
    if (!llmUrl || !llmModel || !llmApiKey) {
      this.showError('请填写完整的大模型配置信息');
      return;
    }

    try {
      console.log('测试大模型连接:', {
        url: llmUrl,
        model: llmModel,
        hasApiKey: !!llmApiKey
      });

      // 使用OpenAI Node.js组件
      const OpenAI = require('openai');
      
      const openai = new OpenAI({
        apiKey: llmApiKey,
        baseURL: llmUrl, // 自定义基础URL
        dangerouslyAllowBrowser: true, // 允许在浏览器环境中运行
      });

      const response = await openai.chat.completions.create({
        model: llmModel,
        messages: [
          {
            role: 'user',
            content: '请回复"测试成功"来验证连接。'
          }
        ],
        max_tokens: 50,
        temperature: 0.7
      });

      console.log('响应数据:', response);
      
      if (response.choices && response.choices[0] && response.choices[0].message) {
        this.showMessage('大模型连接测试成功');
      } else {
        throw new Error('响应格式不正确');
      }
    } catch (error) {
      console.error('大模型测试详细错误:', error);
      
      // 提供更友好的错误提示
      let errorMessage = '大模型测试失败: ' + error.message;
      
      if (error.message.includes('404')) {
        errorMessage += '\n\n可能的原因：\n1. API地址路径不正确，请检查是否需要在URL后添加 /chat/completions\n2. 本地大模型服务未启动\n3. 端口号错误';
      } else if (error.message.includes('Failed to fetch') || error.message.includes('ENOTFOUND')) {
        errorMessage += '\n\n可能的原因：\n1. 网络连接问题\n2. 本地大模型服务未启动\n3. 防火墙阻止连接';
      } else if (error.message.includes('401')) {
        errorMessage += '\n\n可能的原因：\n1. API密钥错误\n2. API密钥权限不足';
      }
      
      this.showError(errorMessage);
    }
  }

  // 保存应用状态
  saveAppState() {
    try {
      const state = {
        filePath: this.lastFilePath,
        page: this.currentPage,
        zoom: this.currentZoom,
        zoomMode: this.zoomMode,
        scrollTop: this.getCurrentScrollTop()
      };
      localStorage.setItem('appState', JSON.stringify(state));
      console.log('应用状态已保存:', state);
    } catch (error) {
      console.error('保存应用状态失败:', error);
    }
  }

  // 加载应用状态
  loadAppState() {
    try {
      const stateStr = localStorage.getItem('appState');
      if (stateStr) {
        const state = JSON.parse(stateStr);
        this.lastFilePath = state.filePath || '';
        this.lastPage = state.page || 1;
        this.lastZoom = state.zoom || 100;
        this.lastZoomMode = state.zoomMode || 'fit-width';
        this.lastScrollTop = state.scrollTop || 0;
        
        console.log('应用状态已加载:', state);
        return state;
      }
    } catch (error) {
      console.error('加载应用状态失败:', error);
    }
    return null;
  }

  // 获取当前滚动位置
  getCurrentScrollTop() {
    const container = document.getElementById('pdf-viewer-container');
    return container ? container.scrollTop : 0;
  }

  // 设置滚动位置
  setScrollTop(scrollTop) {
    const container = document.getElementById('pdf-viewer-container');
    if (container) {
      container.scrollTop = scrollTop;
    }
  }

  // 添加分割条拖动功能
  setupResizer() {
    // 防抖变量，避免拖动时过于频繁重绘
    let highlightUpdateFrame = null;
    let zoomUpdateTimeout = null;
    
    const scheduleHighlightUpdate = () => {
      if (highlightUpdateFrame) {
        cancelAnimationFrame(highlightUpdateFrame);
      }
      highlightUpdateFrame = requestAnimationFrame(() => {
        if (this.recalculateHighlights) {
          this.recalculateHighlights();
        }
        highlightUpdateFrame = null;
      });
    };
    
    const scheduleZoomUpdate = () => {
      if (zoomUpdateTimeout) {
        clearTimeout(zoomUpdateTimeout);
      }
      zoomUpdateTimeout = setTimeout(() => {
        this.updateCurrentZoomDisplay();
        zoomUpdateTimeout = null;
      }, 100); // 100ms防抖
    };
    
    // 水平分割条（翻译区域）
    const resizer = document.getElementById('translation-resizer');
    const fullSection = document.querySelector('.full-translation-section');
    const selectionSection = document.querySelector('.selection-translation-section');
    
    // 设置水平分割条（翻译区域）
    if (resizer && fullSection && selectionSection) {
      let horizontalDragTimeout = null;
      let isHorizontalDragging = false;
      
      const startDragging = (e) => {
        // 延迟150ms再开始拖拽，给双击事件留时间
        horizontalDragTimeout = setTimeout(() => {
          if (!isHorizontalDragging) {
            isHorizontalDragging = true;
            e.preventDefault();
            resizer.classList.add('dragging');
            document.body.classList.add('resizing');
            
            const startY = e.clientY;
            const startHeight = fullSection.offsetHeight;
            const containerHeight = fullSection.parentElement.offsetHeight;
            const resizerHeight = resizer.offsetHeight;
            const minHeight = 100; // 最小高度
            const maxHeight = containerHeight - resizerHeight - 80; // 最大高度
            
            const doDrag = (e) => {
              const deltaY = e.clientY - startY;
              const newHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + deltaY));
              
              fullSection.style.flex = 'none';
              fullSection.style.height = newHeight + 'px';
              selectionSection.style.flex = '1';
              
              // 在拖动过程中实时重绘高亮选区
              scheduleHighlightUpdate();
              
              // 更新缩放比例显示
              scheduleZoomUpdate();
            };
            
            const stopDragging = () => {
              isHorizontalDragging = false;
              resizer.classList.remove('dragging');
              document.body.classList.remove('resizing');
              document.removeEventListener('mousemove', doDrag);
              document.removeEventListener('mouseup', stopDragging);
              
              // 拖动结束后最后重绘一次，确保位置精确
              if (this.recalculateHighlights) {
                setTimeout(() => {
                  this.recalculateHighlights();
                }, 50);
              }
              
              // 拖动结束后更新缩放比例显示
              setTimeout(() => {
                this.updateCurrentZoomDisplay();
              }, 100);
            };
            
            document.addEventListener('mousemove', doDrag);
            document.addEventListener('mouseup', stopDragging);
          }
        }, 150);
      };
      
      // mouseup时清除拖拽超时
      const clearHorizontalDragTimeout = () => {
        if (horizontalDragTimeout) {
          clearTimeout(horizontalDragTimeout);
          horizontalDragTimeout = null;
        }
        isHorizontalDragging = false;
      };
      
      resizer.addEventListener('mousedown', startDragging);
      resizer.addEventListener('mouseup', clearHorizontalDragTimeout);
      
      // 添加双击重置功能 - 水平分割线重置到80%
      resizer.addEventListener('dblclick', (e) => {
        e.preventDefault();
        
        // 清除拖拽超时，防止双击时触发拖拽
        if (horizontalDragTimeout) {
          clearTimeout(horizontalDragTimeout);
          horizontalDragTimeout = null;
        }
        
        console.log('水平分割线双击事件触发');
        this.resetHorizontalResizer();
      });
    }
    
    // 垂直分割条（左右两栏）
    const verticalResizer = document.getElementById('vertical-resizer');
    const pdfContainer = document.querySelector('.pdf-container');
    const rightPanel = document.querySelector('.right-panel');
    
    // 设置垂直分割条
    if (verticalResizer && pdfContainer && rightPanel) {
      let dragStartTime = 0;
      let isDragging = false;
      let dragTimeout = null;
      
      const startVerticalDragging = (e) => {
        dragStartTime = Date.now();
        
        // 延迟150ms再开始拖拽，给双击事件留时间
        dragTimeout = setTimeout(() => {
          if (!isDragging) {
            isDragging = true;
            e.preventDefault();
            verticalResizer.classList.add('dragging');
            document.body.classList.add('resizing-vertical');
            
            const startX = e.clientX;
            const containerWidth = pdfContainer.parentElement.offsetWidth;
            const resizerWidth = verticalResizer.offsetWidth;
            const minWidth = 200; // 最小宽度
            const maxWidth = containerWidth - resizerWidth - minWidth; // 最大宽度
            
            // 获取当前PDF容器的宽度
            const startPdfWidth = pdfContainer.offsetWidth;
            
            const doVerticalDrag = (e) => {
              const deltaX = e.clientX - startX;
              const newPdfWidth = Math.max(minWidth, Math.min(maxWidth, startPdfWidth + deltaX));
              
              // 设置PDF容器的宽度
              pdfContainer.style.flex = 'none';
              pdfContainer.style.width = newPdfWidth + 'px';
              
              // 右侧面板自动填充剩余空间
              rightPanel.style.flex = '1';
              
              // 在拖动过程中实时重绘高亮选区
              scheduleHighlightUpdate();
              
              // 更新缩放比例显示
              scheduleZoomUpdate();
            };
            
            const stopVerticalDragging = () => {
              isDragging = false;
              verticalResizer.classList.remove('dragging');
              document.body.classList.remove('resizing-vertical');
              document.removeEventListener('mousemove', doVerticalDrag);
              document.removeEventListener('mouseup', stopVerticalDragging);
              
              // 拖动结束后最后重绘一次，确保位置精确
              if (this.recalculateHighlights) {
                setTimeout(() => {
                  this.recalculateHighlights();
                }, 50);
              }
              
              // 拖动结束后更新缩放比例显示
              setTimeout(() => {
                this.updateCurrentZoomDisplay();
              }, 100);
            };
            
            document.addEventListener('mousemove', doVerticalDrag);
            document.addEventListener('mouseup', stopVerticalDragging);
          }
        }, 150);
      };
      
      // mouseup时清除拖拽超时
      const clearDragTimeout = () => {
        if (dragTimeout) {
          clearTimeout(dragTimeout);
          dragTimeout = null;
        }
        isDragging = false;
      };
    
      verticalResizer.addEventListener('mousedown', startVerticalDragging);
      verticalResizer.addEventListener('mouseup', clearDragTimeout);
      
      // 添加双击重置功能 - 垂直分割线重置到50%
      verticalResizer.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        // 清除拖拽超时，防止双击时触发拖拽
        if (dragTimeout) {
          clearTimeout(dragTimeout);
          dragTimeout = null;
        }
        
        console.log('垂直分割线双击事件触发');
        this.resetVerticalResizer();
      });
    }
  }

  // 重置水平分割线到默认位置（80%）
  resetHorizontalResizer() {
    const fullSection = document.querySelector('.full-translation-section');
    const selectionSection = document.querySelector('.selection-translation-section');
    
    if (fullSection && selectionSection) {
      // 重置为flex布局的默认比例
      fullSection.style.flex = '0.8'; // 80%
      fullSection.style.height = 'auto';
      selectionSection.style.flex = '0.2'; // 20%
      
      // 重新计算高亮选区
      if (this.recalculateHighlights) {
        setTimeout(() => {
          this.recalculateHighlights();
        }, 50);
      }
      
      // 更新缩放比例显示
      setTimeout(() => {
        this.updateCurrentZoomDisplay();
      }, 100);
      
      this.showMessage('分割线已重置到默认位置');
    }
  }

  // 重置垂直分割线到默认位置（50%）
  resetVerticalResizer() {
    const pdfContainer = document.querySelector('.pdf-container');
    const rightPanel = document.querySelector('.right-panel');
    
    if (pdfContainer && rightPanel) {
      // 重置为flex布局的默认比例
      pdfContainer.style.flex = '1'; // 50%
      pdfContainer.style.width = 'auto';
      rightPanel.style.flex = '1'; // 50%
      
      // 重新计算高亮选区
      if (this.recalculateHighlights) {
        setTimeout(() => {
          this.recalculateHighlights();
        }, 50);
      }
      
      // 更新缩放比例显示
      setTimeout(() => {
        this.updateCurrentZoomDisplay();
      }, 100);
      
      this.showMessage('分割线已重置到默认位置');
    }
  }

  // 计算并更新当前实际缩放比例
  updateCurrentZoomDisplay() {
    if (!this.currentPdf) return;
    
    const container = document.getElementById('pdf-viewer-container');
    const canvas = container.querySelector('canvas');
    
    if (!canvas) return;
    
    // 获取当前容器尺寸
    const containerWidth = container.clientWidth - 40; // 减去左右padding
    
    // 获取canvas的实际显示宽度
    const canvasDisplayWidth = canvas.getBoundingClientRect().width;
    
    // 获取PDF页面的原始宽度（scale=1时的宽度）
    const originalWidth = canvas.width / (canvas.height / canvas.naturalHeight || 1);
    
    // 如果有当前页面，重新计算原始尺寸
    if (this.currentPage) {
      this.currentPdf.getPage(this.currentPage).then(page => {
        const originalViewport = page.getViewport({ scale: 1.0 });
        const actualScale = canvasDisplayWidth / originalViewport.width;
        const actualZoomPercent = Math.round(actualScale * 100);
        
        // 更新显示的缩放比例
        this.currentZoom = actualZoomPercent;
        const zoomInput = document.getElementById('zoom-input');
        if (zoomInput && zoomInput.value != actualZoomPercent) {
          zoomInput.value = actualZoomPercent;
        }
        
        // 如果当前是适应宽度模式，同时更新适应宽度的缩放比例
        if (this.zoomMode === 'fit-width') {
          const newContainerWidth = container.clientWidth - 40;
          this.fitWidthScale = newContainerWidth / originalViewport.width;
        }
      }).catch(error => {
        console.error('更新缩放比例时出错:', error);
      });
    }
  }

  // 版本检测和更新内容清单
  async checkVersionUpdate() {
    try {
      const { ipcRenderer } = require('electron');
      const versionInfo = await ipcRenderer.invoke('check-version-update');
      
      if (versionInfo.isFirstRun) {
        this.showWelcomeDialog(versionInfo);
      } else if (versionInfo.isUpdate) {
        this.showUpdateDialog(versionInfo);
      }
    } catch (error) {
      console.error('版本检查失败:', error);
    }
  }

  // 显示欢迎对话框（首次运行）
  showWelcomeDialog(versionInfo) {
    const modal = this.createUpdateModal({
      title: '欢迎使用论文阅读助手',
      version: versionInfo.currentVersion,
      isFirstRun: true,
      changelogMarkdown: versionInfo.changelogMarkdown
    });
    
    document.body.appendChild(modal);
    setTimeout(() => modal.classList.add('show'), 10);
  }

  // 显示更新对话框
  showUpdateDialog(versionInfo) {
    const modal = this.createUpdateModal({
      title: `应用已更新 v${versionInfo.currentVersion}`,
      version: versionInfo.currentVersion,
      previousVersion: versionInfo.previousVersion,
      isFirstRun: false,
      changelogMarkdown: versionInfo.changelogMarkdown
    });
    
    document.body.appendChild(modal);
    setTimeout(() => modal.classList.add('show'), 10);
  }

  // 创建更新内容清单模态框
  createUpdateModal({ title, version, previousVersion, isFirstRun, changelogMarkdown }) {
    const modal = document.createElement('div');
    modal.className = 'version-modal';
    
    // 使用 marked 库将 Markdown 转换为 HTML
    let changelogHtml = '';
    if (changelogMarkdown) {
      try {
        changelogHtml = marked.parse(changelogMarkdown);
        
        // 为当前版本添加特殊标记
        if (version) {
          const versionRegex = new RegExp(`<h2[^>]*>版本\\s+${version}`, 'g');
          changelogHtml = changelogHtml.replace(versionRegex, 
            `<h2 class="current-version">版本 ${version} <span class="current-badge">当前版本</span>`
          );
        }
      } catch (error) {
        console.error('解析 Markdown 失败:', error);
        changelogHtml = '<p>无法加载更新记录</p>';
      }
    } else {
      changelogHtml = '<p>无更新记录</p>';
    }
    
    modal.innerHTML = `
      <div class="version-modal-content">
        <div class="version-modal-header">
          <h3>${title}</h3>
        </div>
        <div class="version-modal-body">
          <div class="changelog-container markdown-content">
            ${changelogHtml}
          </div>
        </div>
        <div class="version-modal-footer">
          <button class="version-close-btn">${isFirstRun ? '开始使用' : '我知道了'}</button>
        </div>
      </div>
    `;

    // 添加关闭事件
    const closeBtn = modal.querySelector('.version-close-btn');
    closeBtn.addEventListener('click', () => {
      modal.classList.remove('show');
      setTimeout(() => {
        document.body.removeChild(modal);
      }, 300);
    });

    // 点击背景关闭
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeBtn.click();
      }
    });

    return modal;
  }
}

// 初始化应用
document.addEventListener('DOMContentLoaded', () => {
  new PaperReader();
}); 