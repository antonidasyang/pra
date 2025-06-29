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
        
        // 提取大纲（会自动检查并使用保存的大纲）
        this.extractOutline();
        
        // 检查并加载上次的解读结果
        this.loadSavedInterpretation();
        
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

    // 添加刷新大纲功能
    document.getElementById('refresh-outline').addEventListener('click', () => {
      this.refreshOutline();
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
      
      // 如果PDF已加载，应用动态约束（只限制下限，不限制上限）
      if (this.currentPdf && this.fitPageScale) {
        const minZoom = Math.round(this.fitPageScale * 100);
        
        // 只限制最小缩放范围，不限制最大缩放
        newZoom = Math.max(minZoom, newZoom);
        
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
          // 向上滚动，放大（取消上限限制）
          const newZoom = this.currentZoom + zoomStep;
          this.currentZoom = newZoom;
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
    
    // 如果PDF已加载，动态更新输入框的min属性（不设置max限制）
    if (this.currentPdf && this.fitPageScale) {
      const minZoom = Math.round(this.fitPageScale * 100);
      zoomInput.min = minZoom;
      zoomInput.removeAttribute('max'); // 移除最大值限制
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
        
        // 检查并加载上次的解读结果
        this.loadSavedInterpretation();
        
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
      
      // 限制缩放范围（只限制下限，不限制上限）
      scale = Math.max(0.25, scale);
      
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
      } else if (this.zoomMode === 'custom' && scale > this.fitWidthScale) {
        // 自定义模式且缩放比例大于适应宽度时，允许超出容器并居中显示
        canvas.style.maxWidth = 'none';
        canvas.style.width = 'auto';
        canvas.style.height = 'auto';
        canvas.style.display = 'block';
        canvas.style.margin = '0 auto';
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
      
      // 创建一个包装器来包含canvas和高亮框，确保高亮框能被正确剪裁
      const canvasWrapper = document.createElement('div');
      canvasWrapper.style.position = 'relative';
      canvasWrapper.style.display = 'inline-block';
      canvasWrapper.style.overflow = 'visible'; // canvas包装器不剪裁内容
      
      canvasWrapper.appendChild(canvas);
      container.appendChild(canvasWrapper);
      
      // 根据canvas实际宽度调整容器样式
      const containerDisplayWidth = container.clientWidth;
      const canvasDisplayWidth = canvas.getBoundingClientRect().width;
      
      // 当canvas宽度超过容器可用宽度时，调整布局以确保内容完整显示
      if (canvasDisplayWidth > containerDisplayWidth - 40) { // 40px是左右padding的总和
        container.classList.add('high-zoom');
        // 为canvas包装器添加左边距，保持视觉对齐
        canvasWrapper.style.marginLeft = '20px';
      } else {
        container.classList.remove('high-zoom');
        canvasWrapper.style.marginLeft = '';
      }
      
      // 在页面渲染完成后立即进行段落拼接
      await this.processPageText(page, viewport);
      
      // 添加文本选择功能
      this.addTextSelectionSupport(canvas, page, viewport);
      
      this.currentPage = pageNumber;
      this.updatePageInfo();
      this.updateZoomButtons();
      this.updatePageArrows();
      
      // 翻页后将滚动条重置到顶部
      container.scrollTop = 0;
      
      // 更新侧边栏中的目录高亮
      this.updateOutlineHighlight(pageNumber);
      
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
    document.getElementById('llm-context-length').value = settings.llmContextLength || 8192;
    document.getElementById('llm-api-key').value = settings.llmApiKey || '';
    document.getElementById('interpretation-prompt').value = settings.interpretationPrompt || '';
    document.getElementById('enable-scroll-page-turn').checked = settings.enableScrollPageTurn !== false; // 默认为true
    document.getElementById('enable-ai-outline').checked = settings.enableAiOutline !== false; // 默认为true
    
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
      llmContextLength: parseInt(document.getElementById('llm-context-length').value) || 8192,
      llmApiKey: document.getElementById('llm-api-key').value.trim(),
      interpretationPrompt: document.getElementById('interpretation-prompt').value.trim(),
      enableScrollPageTurn: document.getElementById('enable-scroll-page-turn').checked,
      enableAiOutline: document.getElementById('enable-ai-outline').checked
    };
    
    // 保存到localStorage
    localStorage.setItem('settings', JSON.stringify(settings));
    
    // 更新缓存的设置
    this.enableScrollPageTurn = settings.enableScrollPageTurn;
    this.enableAiOutline = settings.enableAiOutline;
    
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
        this.llmContextLength = settings.llmContextLength || 8192;
        this.llmApiKey = settings.llmApiKey || '';
        this.interpretationPrompt = settings.interpretationPrompt || '';
        this.enableScrollPageTurn = settings.enableScrollPageTurn !== false; // 缓存设置，默认为true
        this.enableAiOutline = settings.enableAiOutline !== false; // 缓存AI目录设置，默认为true
        
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
      llmContextLength: 8192,
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
      enableScrollPageTurn: true,
      enableAiOutline: true
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
      // 首先检查是否有保存的大纲
      const savedOutline = this.loadSavedOutline();
      if (savedOutline && savedOutline.data) {
        console.log('使用保存的大纲结果');
        
        // 显示保存的大纲，并添加时间提示
        if (savedOutline.isAiGenerated) {
          // 如果是AI生成的大纲，使用AI大纲显示方式
          this.displayLLMOutlineWithIndicator(savedOutline.data, savedOutline.timestamp);
        } else {
          // 如果是PDF内置大纲，使用普通大纲显示方式
          this.displayOutlineWithIndicator(savedOutline.data, savedOutline.timestamp);
        }
        return;
      }

      // 没有保存的大纲，尝试获取PDF自带的大纲
      const pdfOutline = await this.currentPdf.getOutline();
      if (pdfOutline && pdfOutline.length > 0) {
        this.displayOutline(pdfOutline);
        // 保存PDF内置大纲
        this.saveOutline(pdfOutline, false);
        return;
      }

      // 如果PDF没有大纲，根据设置决定是否使用大模型提取目录
      if (this.enableAiOutline) {
        await this.extractOutlineWithLLM();
      } else {
        this.displayOutline([]);
      }
    } catch (error) {
      console.error('提取大纲失败:', error);
      this.displayOutline([]);
    }
  }

  // 刷新大纲（手动重新提取）
  async refreshOutline() {
    if (!this.currentPdf) {
      this.showError('请先加载PDF文件');
      return;
    }

    try {
      const container = document.getElementById('outline-content');
      
      // 显示加载状态
      container.innerHTML = `
        <div class="loading">
          <div class="loading-dots">
            <div></div>
            <div></div>
            <div></div>
          </div>
          <div style="margin-top: 10px; font-size: 12px;">正在重新提取大纲...</div>
        </div>
      `;

      // 检查设置
      const settings = this.loadSettings();
      if (!settings.enableAiOutline) {
        // 如果没有启用AI大纲，只显示PDF自带大纲
        const pdfOutline = await this.currentPdf.getOutline();
        if (pdfOutline && pdfOutline.length > 0) {
          this.displayOutline(pdfOutline);
        } else {
          container.innerHTML = '<div class="loading">该PDF没有内置大纲，请在设置中启用AI智能目录提取</div>';
        }
        return;
      }

      // 检查大模型配置
      const { llmUrl, llmModel, llmApiKey } = settings;
      if (!llmUrl || !llmModel || !llmApiKey) {
        container.innerHTML = '<div class="loading">请先在设置中配置大模型信息</div>';
        return;
      }

      // 强制使用AI重新提取大纲
      await this.extractOutlineWithLLM();
      
      // 提示用户大纲已更新
      setTimeout(() => {
        const container = document.getElementById('outline-content');
        if (container && !container.innerHTML.includes('刷新大纲失败')) {
          // 如果解析成功，显示更新提示
          const existingIndicator = container.querySelector('div[style*="background: #e3f2fd"]');
          if (existingIndicator) {
            existingIndicator.style.background = '#e8f5e8';
            existingIndicator.style.borderColor = '#c3e6c3';
            existingIndicator.querySelector('span').innerHTML = '🔄 大纲已更新 (AI重新生成)';
            existingIndicator.querySelector('span').style.color = '#155724';
            
            // 3秒后恢复原样
            setTimeout(() => {
              existingIndicator.style.background = '#e3f2fd';
              existingIndicator.style.borderColor = '#90caf9';
              existingIndicator.querySelector('span').innerHTML = '🤖 使用保存的大纲 (AI生成)';
              existingIndicator.querySelector('span').style.color = '#1565c0';
            }, 3000);
          }
        }
      }, 500);
      
    } catch (error) {
      console.error('刷新大纲失败:', error);
      const container = document.getElementById('outline-content');
      container.innerHTML = `<div class="loading">刷新大纲失败: ${error.message}</div>`;
    }
  }

  async extractOutlineWithLLM() {
    const container = document.getElementById('outline-content');
    
    // 显示加载状态
    container.innerHTML = `
      <div class="loading">
        <div class="loading-dots">
          <div></div>
          <div></div>
          <div></div>
        </div>
        <div style="margin-top: 10px; font-size: 12px;">正在使用AI分析整篇论文提取目录...</div>
      </div>
    `;

    try {
      // 获取设置
      const settings = this.loadSettings();
      const { llmUrl, llmModel, llmApiKey } = settings;
      
      if (!llmUrl || !llmModel || !llmApiKey) {
        container.innerHTML = '<div class="loading">请先在设置中配置大模型信息</div>';
        return;
      }

      // 提取全篇文本内容用于分析
      let combinedText = '';
      
      // 使用已有的提取全篇文本方法
      try {
        combinedText = await this.extractFullPaperText();
      } catch (error) {
        console.error('提取全篇文本失败，改用前5页:', error);
        // 如果提取全篇失败，回退到前5页
        const maxPagesToAnalyze = Math.min(5, this.totalPages);
        for (let pageNum = 1; pageNum <= maxPagesToAnalyze; pageNum++) {
          const page = await this.currentPdf.getPage(pageNum);
          const textContent = await page.getTextContent();
          
          // 拼接页面文本
          let pageText = `--- 第${pageNum}页 ---\n`;
          textContent.items.forEach(item => {
            if (item.str.trim()) {
              pageText += item.str + ' ';
            }
          });
          combinedText += pageText + '\n\n';
        }
      }

      if (!combinedText.trim()) {
        container.innerHTML = '<div class="loading">文档中没有找到可分析的文本内容</div>';
        return;
      }

      // 构建提示词
      const prompt = `请分析以下完整论文内容，提取出论文的目录结构。要求：
1. 识别论文的章节和小节标题结构
2. 准确判断每个标题对应的页码
3. 返回JSON格式的目录结构
4. 每个目录项包含：title（标题）、page（页码）、level（层级，1为一级标题，2为二级标题，以此类推）
5. 请注意文档中的页码标记"=== 第X页 ==="来准确定位标题位置
6. 只返回JSON数组，不要其他解释

完整论文内容：
${combinedText}

请返回格式如下的JSON数组：
[
  {"title": "摘要", "page": 1, "level": 1},
  {"title": "1. 引言", "page": 2, "level": 1},
  {"title": "1.1 研究背景", "page": 2, "level": 2},
  {"title": "1.2 研究目标", "page": 3, "level": 2},
  {"title": "2. 相关工作", "page": 4, "level": 1},
  {"title": "3. 方法", "page": 6, "level": 1},
  {"title": "3.1 算法设计", "page": 6, "level": 2},
  {"title": "4. 实验结果", "page": 10, "level": 1},
  {"title": "5. 结论", "page": 15, "level": 1}
]`;

      // 调用大模型API
      const response = await this.callLLMAPI(prompt, llmUrl, llmModel, llmApiKey);
      
      if (response) {
        try {
          // 尝试解析JSON响应
          let outlineData;
          
          // 清理响应文本，提取JSON部分
          let cleanResponse = response.trim();
          
          // 尝试找到JSON数组的开始和结束
          const jsonStart = cleanResponse.indexOf('[');
          const jsonEnd = cleanResponse.lastIndexOf(']');
          
          if (jsonStart !== -1 && jsonEnd !== -1) {
            cleanResponse = cleanResponse.substring(jsonStart, jsonEnd + 1);
          }
          
          outlineData = JSON.parse(cleanResponse);
          
          if (Array.isArray(outlineData) && outlineData.length > 0) {
            this.displayLLMOutline(outlineData);
            // 保存AI生成的大纲
            this.saveOutline(outlineData, true);
          } else {
            container.innerHTML = '<div class="loading">AI未能识别出文档目录结构</div>';
          }
        } catch (parseError) {
          console.error('解析AI响应失败:', parseError);
          console.log('AI原始响应:', response);
          container.innerHTML = '<div class="loading">AI响应格式解析失败，请检查模型配置</div>';
        }
      } else {
        container.innerHTML = '<div class="loading">AI分析失败，请检查网络连接和模型配置</div>';
      }
    } catch (error) {
      console.error('AI提取目录失败:', error);
      container.innerHTML = `<div class="loading">AI提取失败: ${error.message}</div>`;
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

  // 显示带时间提示的普通大纲
  displayOutlineWithIndicator(outline, timestamp) {
    const container = document.getElementById('outline-content');
    
    if (!outline || outline.length === 0) {
      container.innerHTML = '<div class="loading">该PDF没有大纲信息</div>';
      return;
    }

    // 添加时间提示
    const timeIndicator = `
      <div style="background: #e8f5e8; border: 1px solid #c3e6c3; border-radius: 6px; padding: 8px; margin-bottom: 12px; font-size: 11px;">
        <div style="color: #155724; display: flex; align-items: center; justify-content: space-between;">
          <span>💾 使用保存的大纲 (PDF内置)</span>
          <button id="refresh-outline-inline" style="background: #28a745; color: white; border: none; padding: 2px 6px; border-radius: 3px; font-size: 10px; cursor: pointer;">🔄</button>
        </div>
        <div style="color: #155724; margin-top: 4px;">
          保存时间: ${new Date(timestamp).toLocaleString()}
        </div>
      </div>
    `;

    const outlineHtml = outline.map(item => {
      const pageNumber = this.getPageNumberFromDest(item.dest);
      return `
        <div class="outline-item" data-page="${pageNumber}">
          <div class="title">${item.title}</div>
          <div class="page">第 ${pageNumber} 页</div>
        </div>
      `;
    }).join('');

    container.innerHTML = timeIndicator + outlineHtml;

    // 添加内联刷新按钮事件
    const inlineRefreshBtn = document.getElementById('refresh-outline-inline');
    if (inlineRefreshBtn) {
      inlineRefreshBtn.addEventListener('click', () => {
        this.refreshOutline();
      });
    }

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

  // 显示带时间提示的AI大纲
  displayLLMOutlineWithIndicator(outlineData, timestamp) {
    const container = document.getElementById('outline-content');
    
    if (!outlineData || outlineData.length === 0) {
      container.innerHTML = '<div class="loading">AI未能提取到目录信息</div>';
      return;
    }

    // 添加时间提示
    const timeIndicator = `
      <div style="background: #e3f2fd; border: 1px solid #90caf9; border-radius: 6px; padding: 8px; margin-bottom: 12px; font-size: 11px;">
        <div style="color: #1565c0; display: flex; align-items: center; justify-content: space-between;">
          <span>🤖 使用保存的大纲 (AI生成)</span>
          <button id="refresh-outline-inline" style="background: #1976d2; color: white; border: none; padding: 2px 6px; border-radius: 3px; font-size: 10px; cursor: pointer;">🔄</button>
        </div>
        <div style="color: #1565c0; margin-top: 4px;">
          保存时间: ${new Date(timestamp).toLocaleString()}
        </div>
      </div>
    `;

    // 构建树形结构HTML
    let outlineHtml = '<div class="llm-outline-tree">';
    
    outlineData.forEach((item, index) => {
      const level = item.level || 1;
      const title = item.title || '未知标题';
      const page = item.page || 1;
      
      // 确保页码在有效范围内
      const validPage = Math.max(1, Math.min(page, this.totalPages));
      
      outlineHtml += `
        <div class="outline-item llm-outline-item level-${level}" data-page="${validPage}">
          <div class="outline-content">
            <div class="outline-icon">
              ${level === 1 ? '📁' : level === 2 ? '📄' : '▪'}
            </div>
            <div class="outline-text">
              <div class="title">${title}</div>
              <div class="page">第 ${validPage} 页</div>
            </div>
          </div>
        </div>
      `;
    });
    
    outlineHtml += '</div>';
    container.innerHTML = timeIndicator + outlineHtml;

    // 添加内联刷新按钮事件
    const inlineRefreshBtn = document.getElementById('refresh-outline-inline');
    if (inlineRefreshBtn) {
      inlineRefreshBtn.addEventListener('click', () => {
        this.refreshOutline();
      });
    }

    // 添加点击事件
    container.querySelectorAll('.llm-outline-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        
        // 高亮当前选中项
        container.querySelectorAll('.llm-outline-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        
        // 跳转到对应页面
        const pageNumber = parseInt(item.dataset.page);
        if (pageNumber && pageNumber > 0 && pageNumber <= this.totalPages) {
          this.showPDFPage(pageNumber);
        }
      });
      
      // 添加悬停效果
      item.addEventListener('mouseenter', () => {
        item.style.backgroundColor = '#e8f4fd';
      });
      
      item.addEventListener('mouseleave', () => {
        if (!item.classList.contains('active')) {
          item.style.backgroundColor = '';
        }
      });
    });
  }

  displayLLMOutline(outlineData) {
    const container = document.getElementById('outline-content');
    
    if (!outlineData || outlineData.length === 0) {
      container.innerHTML = '<div class="loading">AI未能提取到目录信息</div>';
      return;
    }

    // 构建树形结构HTML
    let outlineHtml = '<div class="llm-outline-tree">';
    
    outlineData.forEach((item, index) => {
      const level = item.level || 1;
      const title = item.title || '未知标题';
      const page = item.page || 1;
      
      // 确保页码在有效范围内
      const validPage = Math.max(1, Math.min(page, this.totalPages));
      
      outlineHtml += `
        <div class="outline-item llm-outline-item level-${level}" data-page="${validPage}">
          <div class="outline-content">
            <div class="outline-icon">
              ${level === 1 ? '📁' : level === 2 ? '📄' : '▪'}
            </div>
            <div class="outline-text">
              <div class="title">${title}</div>
              <div class="page">第 ${validPage} 页</div>
            </div>
          </div>
        </div>
      `;
    });
    
    outlineHtml += '</div>';
    container.innerHTML = outlineHtml;

    // 添加点击事件
    container.querySelectorAll('.llm-outline-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        
        // 高亮当前选中项
        container.querySelectorAll('.llm-outline-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        
        // 跳转到对应页面
        const pageNumber = parseInt(item.dataset.page);
        if (pageNumber && pageNumber > 0 && pageNumber <= this.totalPages) {
          this.showPDFPage(pageNumber);
        }
      });
      
      // 添加悬停效果
      item.addEventListener('mouseenter', () => {
        item.style.backgroundColor = '#e8f4fd';
      });
      
      item.addEventListener('mouseleave', () => {
        if (!item.classList.contains('active')) {
          item.style.backgroundColor = '';
        }
      });
         });
   }

   updateOutlineHighlight(currentPage) {
     // 清除所有目录项的高亮
     const outlineItems = document.querySelectorAll('.llm-outline-item, .outline-item');
     outlineItems.forEach(item => {
       item.classList.remove('active');
       item.style.backgroundColor = '';
     });

     // 找到与当前页面最匹配的目录项并高亮
     let bestMatch = null;
     let bestMatchPage = 0;

     outlineItems.forEach(item => {
       const itemPage = parseInt(item.dataset.page);
       if (itemPage <= currentPage && itemPage > bestMatchPage) {
         bestMatch = item;
         bestMatchPage = itemPage;
       }
     });

     if (bestMatch) {
       bestMatch.classList.add('active');
       if (bestMatch.classList.contains('llm-outline-item')) {
         bestMatch.style.backgroundColor = '#3498db';
       }

       // 滚动到可见区域
       const sidebarContent = document.querySelector('.sidebar-content');
       if (sidebarContent) {
         const itemRect = bestMatch.getBoundingClientRect();
         const containerRect = sidebarContent.getBoundingClientRect();
         
         if (itemRect.top < containerRect.top || itemRect.bottom > containerRect.bottom) {
           bestMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
         }
       }
     }
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
      overlay.style.zIndex = '1'; // 降低z-index，确保不会覆盖页面内容
      
      // 获取canvas的实际显示尺寸和位置
      const canvasRect = canvas.getBoundingClientRect();
      const containerRect = canvas.parentElement.getBoundingClientRect();
      
      // 不需要获取滚动偏移量，因为高亮框会直接定位在canvas上
      
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
      
      // 计算相对于canvas的位置
      // 高亮框直接定位在canvas上，这样会随着canvas一起被容器的overflow剪裁
      const relativeX = itemX;
      const relativeY = canvasY;
      
      // 添加调试信息
      console.log('高亮框位置调试:', {
        itemTransform: item.transform,
        viewportScale: viewport.scale,
        scaleX, scaleY,
        itemX, itemY, itemWidth, itemHeight,
        canvasY,
        canvasOffset: { left: canvas.offsetLeft, top: canvas.offsetTop },
        containerRect: { left: containerRect.left, top: containerRect.top, width: containerRect.width, height: containerRect.height },
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
        // 将高亮框添加到canvas的包装器中，而不是PDF容器中
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
            // 将高亮框添加到canvas的包装器中
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
            // 将高亮框添加到canvas的包装器中
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
              // 将高亮框添加到canvas的包装器中
              canvas.parentElement.appendChild(highlight);
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

  // 解读整篇论文
  async interpretCurrentPage() {
    if (!this.currentPdf) {
      this.showError('请先加载PDF文件');
      return;
    }

    try {
      // 显示加载状态
      const interpretationContent = document.getElementById('interpretation-content');
      interpretationContent.innerHTML = `
        <div class="skeleton-placeholder">
          <div class="loading-dots">
            <div></div>
            <div></div>
            <div></div>
          </div>
          <div style="margin-top: 10px; color: #6c757d;">正在提取整篇论文内容...</div>
        </div>
      `;

      // 获取设置
      const settings = this.loadSettings();
      const { llmUrl, llmModel, llmApiKey, llmContextLength, interpretationPrompt } = settings;
      
      if (!llmUrl || !llmModel || !llmApiKey) {
        this.showError('请先在设置中配置大模型信息');
        return;
      }

      // 提取整篇论文文本
      const fullPaperText = await this.extractFullPaperText();
      
      if (!fullPaperText || fullPaperText.length < 100) {
        this.showError('论文内容过少或无法提取文本内容');
        return;
      }

      // 更新加载状态
      interpretationContent.innerHTML = `
        <div class="skeleton-placeholder">
          <div class="loading-dots">
            <div></div>
            <div></div>
            <div></div>
          </div>
          <div style="margin-top: 10px; color: #6c757d;">正在智能分段解读论文...</div>
        </div>
      `;

      // 根据上下文长度分段并解读
      await this.interpretPaperInChunks(fullPaperText, llmUrl, llmModel, llmApiKey, llmContextLength, interpretationPrompt, interpretationContent);
      
    } catch (error) {
      console.error('解读错误:', error);
      this.showError('解读失败: ' + error.message);
    }
  }

  // 提取整篇论文文本
  async extractFullPaperText() {
    const totalPages = this.currentPdf.numPages;
    let fullText = '';
    
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      try {
        const page = await this.currentPdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        
        let pageText = '';
        textContent.items.forEach(item => {
          pageText += item.str + ' ';
        });
        
        // 清理页面文本
        pageText = pageText.replace(/\s+/g, ' ').trim();
        
        if (pageText) {
          fullText += `\n\n=== 第${pageNum}页 ===\n${pageText}`;
        }
      } catch (error) {
        console.warn(`提取第${pageNum}页文本失败:`, error);
      }
    }
    
    return fullText.trim();
  }

  // 分段解读论文
  async interpretPaperInChunks(fullText, llmUrl, llmModel, llmApiKey, contextLength, interpretationPrompt, contentElement) {
    // 估算token数量（粗略计算：中文约2.5字符/token，英文约4字符/token）
    const estimateTokens = (text) => {
      const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
      const otherChars = text.length - chineseChars;
      return Math.ceil(chineseChars / 2.5 + otherChars / 4);
    };

    const totalTokens = estimateTokens(fullText);
    
    // 预留token空间给提示词和响应（约占30%）
    const availableTokens = Math.floor(contextLength * 0.7);
    
    // 如果文本够短，直接整篇解读
    if (totalTokens <= availableTokens) {
      await this.interpretSingleChunk(fullText, llmUrl, llmModel, llmApiKey, interpretationPrompt, contentElement, '整篇论文');
      return;
    }

    // 需要分段处理
    const chunks = this.splitTextIntoChunks(fullText, availableTokens);
    
    // 计算每段摘要的最大token数（总可用token数除以分段数，再预留一些空间）
    const maxSummaryTokensPerChunk = Math.floor(availableTokens / chunks.length * 0.8);
    
    // 初始化布局显示
    contentElement.innerHTML = `
      <div style="padding: 20px; line-height: 1.6; font-size: 14px; color: #333;">
        <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
          <h3 style="margin: 0 0 10px 0; color: #2c3e50;">📄 整篇论文智能解读</h3>
          <p style="margin: 0; color: #6c757d;">
            论文总长度: ${totalTokens.toLocaleString()} tokens | 
            分段数量: ${chunks.length} 段 | 
            上下文长度: ${contextLength.toLocaleString()} tokens
          </p>
          <p style="margin: 10px 0 0 0; color: #6c757d; font-size: 12px;">
            正在采用两阶段解读：先生成各段摘要，再进行整体分析
          </p>
        </div>
        
        <!-- 整篇论文综合解读放在上面 -->
        <div id="final-result" style="display: none; margin-bottom: 30px;"></div>
        
        <!-- 进度条和分段信息放在下面 -->
        <div class="process-info-section">
          <div style="background: #f8f9fa; padding: 12px 15px; border-radius: 6px; margin-bottom: 15px; border-left: 4px solid #3498db;">
            <h4 style="margin: 0 0 5px 0; color: #2c3e50; font-size: 14px;">📊 处理进度</h4>
            <p style="margin: 0; color: #6c757d; font-size: 12px;">两阶段解读流程：摘要生成 → 整体分析</p>
          </div>
          <div class="progress-container">
            <div class="progress-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
              <span id="progress-text" style="font-size: 13px; color: #495057;">第一阶段：生成分段摘要</span>
              <span id="progress-percent" style="font-size: 13px; color: #6c757d;">0%</span>
            </div>
            <div class="progress-bar" style="width: 100%; height: 8px; background: #e9ecef; border-radius: 4px; overflow: hidden;">
              <div id="progress-fill" style="height: 100%; background: linear-gradient(90deg, #3498db, #2980b9); width: 0%; transition: width 0.3s ease;"></div>
            </div>
            <div id="progress-detail" style="margin-top: 8px; font-size: 12px; color: #6c757d;"></div>
          </div>
        </div>
      </div>
    `;

    try {
      // 第一阶段：生成各段摘要
      const summaries = [];
      const progressFill = document.getElementById('progress-fill');
      const progressPercent = document.getElementById('progress-percent');
      const progressDetail = document.getElementById('progress-detail');
      
      for (let i = 0; i < chunks.length; i++) {
        const chunkTitle = `第${i + 1}段`;
        progressDetail.textContent = `正在生成${chunkTitle}摘要...`;
        
        try {
          const summary = await this.generateChunkSummary(chunks[i], llmUrl, llmModel, llmApiKey, maxSummaryTokensPerChunk);
          summaries.push(summary);
          
          // 更新进度
          const progress = Math.round(((i + 1) / chunks.length) * 50); // 第一阶段占50%
          progressFill.style.width = progress + '%';
          progressPercent.textContent = progress + '%';
          
        } catch (error) {
          console.error(`生成第${i + 1}段摘要失败:`, error);
          summaries.push(`第${i + 1}段摘要生成失败: ${error.message}`);
        }
        
        // 添加小延迟避免请求过频
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      // 第二阶段：整体解读
      document.getElementById('progress-text').textContent = '第二阶段：整体分析解读';
      progressDetail.textContent = '正在基于摘要进行整体分析...';
      progressFill.style.width = '60%';
      progressPercent.textContent = '60%';
      
      // 拼接所有摘要
      const combinedSummary = summaries.map((summary, index) => 
        `=== 第${index + 1}段摘要 ===\n${summary}`
      ).join('\n\n');
      
      // 构建最终解读提示词
      const finalPrompt = `基于以下分段摘要，请对整篇论文进行全面的专业解读：

${interpretationPrompt.replace('{text}', combinedSummary)}

注意：以上内容是对原论文各部分的摘要，请基于这些摘要进行整体性的分析和解读，重点关注论文的整体结构、逻辑关系和核心贡献。`;

      // 最终解读
      const finalResultContainer = document.getElementById('final-result');
      finalResultContainer.style.display = 'block';
      finalResultContainer.innerHTML = `
        <div style="background: #fff; border: 1px solid #ddd; border-radius: 8px; overflow: hidden;">
          <div style="background: #f8f9fa; padding: 12px; border-bottom: 1px solid #ddd;">
            <h4 style="margin: 0; color: #495057;">📋 整篇论文综合解读</h4>
          </div>
          <div class="final-content" style="padding: 20px;">
            <div class="skeleton-placeholder">
              <div class="loading-dots">
                <div></div>
                <div></div>
                <div></div>
              </div>
              <div style="margin-top: 10px; color: #6c757d;">正在进行整体解读分析...</div>
            </div>
          </div>
        </div>
      `;
      
      const finalContent = finalResultContainer.querySelector('.final-content');
      
      // 更新进度到90%
      progressFill.style.width = '90%';
      progressPercent.textContent = '90%';
      
             await this.callLLMAPIStream(finalPrompt, llmUrl, llmModel, llmApiKey, finalContent);
       
       // 完成进度
       progressFill.style.width = '100%';
       progressPercent.textContent = '100%';
       progressDetail.textContent = '解读完成！';
       document.getElementById('progress-text').textContent = '✅ 解读完成';
       
       // 保存解读结果
       setTimeout(() => {
         try {
           const fullContent = contentElement.innerHTML;
           this.saveInterpretation(fullContent);
         } catch (error) {
           console.error('保存解读结果失败:', error);
         }
       }, 1000);
       
       // 3秒后隐藏进度信息区域
       setTimeout(() => {
         const processInfoSection = document.querySelector('.process-info-section');
         if (processInfoSection) {
           processInfoSection.style.opacity = '0.5';
           processInfoSection.style.transition = 'opacity 0.5s ease';
           processInfoSection.style.pointerEvents = 'none';
         }
       }, 3000);
      
    } catch (error) {
      console.error('分段解读过程中出错:', error);
      contentElement.innerHTML = `
        <div style="padding: 20px; color: #e74c3c;">
          解读过程中出错: ${error.message}
        </div>
      `;
    }
  }

  // 分割文本为合适的段落
  splitTextIntoChunks(text, maxTokens) {
    const estimateTokens = (text) => {
      const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
      const otherChars = text.length - chineseChars;
      return Math.ceil(chineseChars / 2.5 + otherChars / 4);
    };

    const chunks = [];
    const pages = text.split(/\n\n=== 第\d+页 ===\n/);
    
    let currentChunk = '';
    let currentTokens = 0;
    
    for (let i = 0; i < pages.length; i++) {
      if (i === 0 && !pages[i].trim()) continue; // 跳过空的第一个元素
      
      const pageText = pages[i].trim();
      if (!pageText) continue;
      
      const pageTokens = estimateTokens(pageText);
      
      // 如果单页就超过限制，强制分割
      if (pageTokens > maxTokens) {
        // 先保存当前块
        if (currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
          currentTokens = 0;
        }
        
        // 按句子分割过长的页面
        const sentences = pageText.split(/[。！？.!?]\s*/);
        let tempChunk = '';
        let tempTokens = 0;
        
        for (const sentence of sentences) {
          if (!sentence.trim()) continue;
          
          const sentenceTokens = estimateTokens(sentence);
          
          if (tempTokens + sentenceTokens > maxTokens && tempChunk) {
            chunks.push(tempChunk.trim());
            tempChunk = sentence;
            tempTokens = sentenceTokens;
          } else {
            tempChunk += (tempChunk ? '。' : '') + sentence;
            tempTokens += sentenceTokens;
          }
        }
        
        if (tempChunk) {
          currentChunk = tempChunk;
          currentTokens = tempTokens;
        }
      } else {
        // 检查是否可以添加到当前块
        if (currentTokens + pageTokens > maxTokens && currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = pageText;
          currentTokens = pageTokens;
        } else {
          currentChunk += (currentChunk ? '\n\n' : '') + pageText;
          currentTokens += pageTokens;
        }
      }
    }
    
    // 添加最后一块
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }
    
    return chunks;
  }

  // 生成分段摘要
  async generateChunkSummary(text, llmUrl, llmModel, llmApiKey, maxTokens) {
    try {
      // 估算字符到token的转换（粗略计算）
      const estimateChars = (tokens) => {
        // 假设中英文混合，平均每token约3个字符
        return Math.floor(tokens * 3);
      };
      
      const maxChars = estimateChars(maxTokens);
      
      const prompt = `请为以下论文片段生成一个简洁的摘要，摘要应该：
1. 提取关键信息和核心观点
2. 保持逻辑结构完整
3. 字数控制在${maxChars}字符以内
4. 用中文回答，格式清晰

论文片段：
${text}

请直接返回摘要内容，不要添加"摘要："等前缀。`;

      const summary = await this.callLLMAPI(prompt, llmUrl, llmModel, llmApiKey);
      
      // 如果摘要过长，进行截断
      if (summary && summary.length > maxChars) {
        return summary.substring(0, maxChars - 3) + '...';
      }
      
      return summary || '摘要生成失败';
      
    } catch (error) {
      console.error('生成摘要失败:', error);
      return `摘要生成失败: ${error.message}`;
    }
  }

  // 解读单个文本段
  async interpretSingleChunk(text, llmUrl, llmModel, llmApiKey, interpretationPrompt, contentElement, chunkTitle) {
    try {
      // 构建针对分段的提示词
      let prompt;
      if (chunkTitle === '整篇论文') {
        prompt = interpretationPrompt.replace('{text}', text);
      } else {
        prompt = `请对以下论文片段进行专业解读分析（${chunkTitle}）：

${interpretationPrompt.replace('{text}', text)}

请注意：这是论文的一个片段，请重点分析此片段的内容，不要重复分析其他部分。`;
      }

      // 调用大模型API进行流式解读
      await this.callLLMAPIStream(prompt, llmUrl, llmModel, llmApiKey, contentElement);
      
      // 如果是整篇论文解读，保存解读结果
      if (chunkTitle === '整篇论文') {
        setTimeout(() => {
          try {
            // 对于整篇论文解读，保存整个父级容器的内容
            const parentElement = contentElement.parentElement;
            if (parentElement) {
              this.saveInterpretation(parentElement.innerHTML);
            }
          } catch (error) {
            console.error('保存整篇解读结果失败:', error);
          }
        }, 1000);
      }
      
    } catch (error) {
      console.error(`解读${chunkTitle}失败:`, error);
      contentElement.innerHTML = `<div style="color: #e74c3c;">解读失败: ${error.message}</div>`;
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

  // 生成文件唯一标识
  generateFileHash(filePath) {
    try {
      const fs = require('fs');
      const stats = fs.statSync(filePath);
      // 使用文件路径和文件大小、修改时间生成简单的哈希
      const hashSource = `${filePath}_${stats.size}_${stats.mtime.getTime()}`;
      return btoa(hashSource).replace(/[^a-zA-Z0-9]/g, '').substring(0, 32);
    } catch (error) {
      console.error('生成文件哈希失败:', error);
      // 如果失败，使用文件路径的简单编码
      return btoa(filePath).replace(/[^a-zA-Z0-9]/g, '').substring(0, 32);
    }
  }

  // 保存解读结果
  saveInterpretation(interpretationContent) {
    try {
      if (!this.lastFilePath || !interpretationContent) {
        console.log('无法保存解读结果：缺少文件路径或解读内容');
        return;
      }

      const fileHash = this.generateFileHash(this.lastFilePath);
      const interpretationData = {
        filePath: this.lastFilePath,
        timestamp: new Date().toISOString(),
        content: interpretationContent,
        fileHash: fileHash
      };

      localStorage.setItem(`interpretation_${fileHash}`, JSON.stringify(interpretationData));
      console.log('解读结果已保存:', { fileHash, filePath: this.lastFilePath });
    } catch (error) {
      console.error('保存解读结果失败:', error);
    }
  }

  // 保存大纲结果
  saveOutline(outlineData, isAiGenerated = false) {
    try {
      if (!this.lastFilePath || !outlineData) {
        console.log('无法保存大纲结果：缺少文件路径或大纲数据');
        return;
      }

      const fileHash = this.generateFileHash(this.lastFilePath);
      const outlineInfo = {
        filePath: this.lastFilePath,
        timestamp: new Date().toISOString(),
        data: outlineData,
        isAiGenerated: isAiGenerated,
        fileHash: fileHash
      };

      localStorage.setItem(`outline_${fileHash}`, JSON.stringify(outlineInfo));
      console.log('大纲结果已保存:', { fileHash, filePath: this.lastFilePath, isAiGenerated });
    } catch (error) {
      console.error('保存大纲结果失败:', error);
    }
  }

  // 加载保存的解读结果
  loadSavedInterpretation() {
    try {
      if (!this.lastFilePath) {
        return;
      }

      const fileHash = this.generateFileHash(this.lastFilePath);
      const savedData = localStorage.getItem(`interpretation_${fileHash}`);
      
      if (savedData) {
        const interpretationData = JSON.parse(savedData);
        const interpretationContent = document.getElementById('interpretation-content');
        
        if (interpretationContent && interpretationData.content) {
          // 添加一个提示，表明这是之前保存的解读结果
          const savedIndicator = `
            <div style="background: #e8f5e8; border: 1px solid #c3e6c3; border-radius: 8px; padding: 12px; margin-bottom: 20px;">
              <div style="display: flex; align-items: center; margin-bottom: 8px;">
                <span style="color: #155724; font-weight: bold;">💾 已加载上次的解读结果</span>
                <button id="refresh-interpretation" style="margin-left: auto; background: #28a745; color: white; border: none; padding: 4px 12px; border-radius: 4px; font-size: 12px; cursor: pointer;">重新解读</button>
              </div>
              <div style="color: #155724; font-size: 12px;">
                保存时间: ${new Date(interpretationData.timestamp).toLocaleString()}
              </div>
            </div>
          `;
          
          interpretationContent.innerHTML = savedIndicator + interpretationData.content;
          
          // 添加重新解读按钮的事件监听
          const refreshBtn = document.getElementById('refresh-interpretation');
          if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
              this.interpretCurrentPage();
            });
          }
          
          console.log('已加载保存的解读结果:', { fileHash, timestamp: interpretationData.timestamp });
        }
      }
    } catch (error) {
      console.error('加载保存的解读结果失败:', error);
    }
  }

  // 加载保存的大纲结果
  loadSavedOutline() {
    try {
      if (!this.lastFilePath) {
        return null;
      }

      const fileHash = this.generateFileHash(this.lastFilePath);
      const savedData = localStorage.getItem(`outline_${fileHash}`);
      
      if (savedData) {
        const outlineInfo = JSON.parse(savedData);
        console.log('找到保存的大纲结果:', { 
          fileHash, 
          timestamp: outlineInfo.timestamp, 
          isAiGenerated: outlineInfo.isAiGenerated 
        });
        return outlineInfo;
      }
      
      return null;
    } catch (error) {
      console.error('加载保存的大纲结果失败:', error);
      return null;
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