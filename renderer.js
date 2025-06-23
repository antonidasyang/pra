const { ipcRenderer } = require('electron');
const axios = require('axios');
const path = require('path');

// PDF.js 配置 - 使用字符串路径
const pdfjsLib = require('pdfjs-dist');
pdfjsLib.GlobalWorkerOptions.workerSrc = 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs';

class PaperReader {
  constructor() {
    this.currentPdf = null;
    this.currentPage = 1;
    this.totalPages = 0;
    this.proxyUrl = '';
    this.init();
  }

  init() {
    this.bindEvents();
    this.setupPDFViewer();
    this.loadSettings();
  }

  bindEvents() {
    document.getElementById('load-pdf').addEventListener('click', () => {
      this.loadPDF();
    });

    document.getElementById('translate-btn').addEventListener('click', () => {
      this.translateCurrentPage();
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
      e.preventDefault();
      this.handleWheelScroll(e);
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

    // 点击模态框外部关闭
    document.getElementById('settings-modal').addEventListener('click', (e) => {
      if (e.target.id === 'settings-modal') {
        this.hideSettings();
      }
    });
  }

  handleWheelScroll(e) {
    if (!this.currentPdf) return;

    // 向上滚动翻到下一页，向下滚动翻到上一页
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
  }

  setupPDFViewer() {
    const container = document.getElementById('pdf-viewer-container');
    container.innerHTML = '<div class="loading">请选择PDF文件</div>';
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
        
        // 更新文件名显示
        document.getElementById('file-name').textContent = fileName;
        
        // 读取文件
        const fs = require('fs');
        const arrayBuffer = fs.readFileSync(filePath);
        
        this.currentPdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        
        this.totalPages = this.currentPdf.numPages;
        this.showPDFPage(1);
        this.extractOutline();
        this.showMessage('PDF加载成功');
        this.updatePageInfo();
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
      const viewport = page.getViewport({ scale: 1.5 });
      
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      canvas.height = viewport.height;
      canvas.width = viewport.width;

      const renderContext = {
        canvasContext: context,
        viewport: viewport
      };

      await page.render(renderContext).promise;
      
      const container = document.getElementById('pdf-viewer-container');
      container.innerHTML = '';
      container.appendChild(canvas);
      
      this.currentPage = pageNumber;
      this.updatePageInfo();
    } catch (error) {
      this.showError('页面渲染失败: ' + error.message);
    }
  }

  async translateCurrentPage() {
    if (!this.currentPdf) {
      this.showError('请先加载PDF文件');
      return;
    }

    try {
      const page = await this.currentPdf.getPage(this.currentPage);
      const textContent = await page.getTextContent();
      
      // 计算平均文本高度
      const heights = textContent.items.map(item => item.height);
      const avgHeight = heights.reduce((a, b) => a + b, 0) / heights.length;
      
      // 使用更小的容差来确保精确分组
      const tolerance = avgHeight * 0.8; // 使用80%的行高作为容差
      
      // 更精确的Y坐标分组
      const lineGroups = {};
      
      textContent.items.forEach(item => {
        // 使用文本的顶部Y坐标进行分组
        const y = Math.round(item.transform[5] / tolerance) * tolerance;
        
        if (!lineGroups[y]) {
          lineGroups[y] = [];
        }
        lineGroups[y].push(item);
      });
      
      // 对每行内的文本按X坐标排序（从左到右）
      Object.keys(lineGroups).forEach(y => {
        lineGroups[y].sort((a, b) => a.transform[4] - b.transform[4]);
      });
      
      // 按Y坐标排序（从上到下）
      const sortedYCoords = Object.keys(lineGroups).sort((a, b) => b - a);
      
      // 计算行间距
      const lineSpacings = [];
      for (let i = 0; i < sortedYCoords.length - 1; i++) {
        const currentY = parseFloat(sortedYCoords[i]);
        const nextY = parseFloat(sortedYCoords[i + 1]);
        const spacing = currentY - nextY;
        lineSpacings.push(spacing);
      }
      
      const avgLineSpacing = lineSpacings.length > 0 ? 
        lineSpacings.reduce((a, b) => a + b, 0) / lineSpacings.length : avgHeight;
      
      // 简化的段落组合逻辑
      const paragraphs = [];
      let currentParagraph = '';
      let lastY = null;
      
      sortedYCoords.forEach((y, index) => {
        const lineItems = lineGroups[y];
        const lineText = lineItems.map(item => item.str).join('');
        
        // 简化的段落判断：主要基于行间距
        let isNewParagraph = false;
        
        if (lastY !== null) {
          const spacing = Math.abs(y - lastY);
          const paragraphThreshold = avgHeight * 1.2; // 1.2倍行高作为段落判断阈值
          // 如果行间距超过1.2倍行高，认为是新段落
          if (spacing > paragraphThreshold) {
            isNewParagraph = true;
          }
        }
        
        // 如果当前段落为空，开始新段落
        if (!currentParagraph.trim()) {
          isNewParagraph = true;
        }
        
        if (isNewParagraph && currentParagraph.trim()) {
          // 结束当前段落
          paragraphs.push(currentParagraph.trim());
          currentParagraph = lineText;
        } else {
          // 继续当前段落，直接拼接，不使用空格
          if (currentParagraph) {
            currentParagraph += lineText;
          } else {
            currentParagraph = lineText;
          }
        }
        
        lastY = y;
      });
      
      // 添加最后一个段落
      if (currentParagraph.trim()) {
        paragraphs.push(currentParagraph.trim());
      }
      
      // 过滤掉界面文字和页码等
      const filteredParagraphs = paragraphs.filter(paragraph => {
        const lowerParagraph = paragraph.toLowerCase();
        // 过滤掉常见的界面文字
        return !lowerParagraph.includes('page') && 
               !lowerParagraph.includes('第') && 
               !lowerParagraph.includes('页') &&
               !lowerParagraph.includes('of') &&
               !lowerParagraph.includes('共') &&
               !lowerParagraph.match(/^\d+$/) && // 纯数字
               paragraph.trim().length > 5; // 减少最小长度要求
      });
      
      if (filteredParagraphs.length === 0) {
        this.showError('当前页面没有可翻译的内容');
        return;
      }

      this.showMessage('正在翻译...');
      const translation = await this.translateText(filteredParagraphs);
      this.displayTranslation(translation);
    } catch (error) {
      this.showError('翻译失败: ' + error.message);
    }
  }

  async translateText(paragraphs) {
    try {
      // 逐个翻译段落
      const translatedParagraphs = [];
      for (let i = 0; i < paragraphs.length; i++) {
        const paragraph = paragraphs[i];
        if (paragraph.trim()) {
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
            translatedParagraphs.push(translation);
          }
        }
      }
      
      return translatedParagraphs.join('\n\n');
    } catch (error) {
      console.error('翻译API错误:', error);
      throw new Error('翻译服务暂时不可用，请稍后重试');
    }
  }

  displayTranslation(translation) {
    const container = document.getElementById('translation-content');
    
    // 只显示翻译结果
    let html = '<div class="translated-text">';
    const translatedParagraphs = translation.split('\n\n');
    translatedParagraphs.forEach(paragraph => {
      if (paragraph.trim()) {
        html += `<p>${paragraph}</p>`;
      }
    });
    html += '</div>';
    
    container.innerHTML = html;
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
    document.getElementById('proxy-url').value = this.proxyUrl;
    document.getElementById('settings-modal').style.display = 'block';
  }

  hideSettings() {
    document.getElementById('settings-modal').style.display = 'none';
  }

  saveSettings() {
    this.proxyUrl = document.getElementById('proxy-url').value.trim();
    localStorage.setItem('proxyUrl', this.proxyUrl);
    
    // 设置全局代理
    if (this.proxyUrl) {
      ipcRenderer.send('set-global-proxy', { proxyUrl: this.proxyUrl });
    } else {
      ipcRenderer.send('clear-global-proxy');
    }
    
    this.hideSettings();
    this.showMessage('设置已保存');
  }

  loadSettings() {
    this.proxyUrl = localStorage.getItem('proxyUrl') || '';
    
    // 加载时设置全局代理
    if (this.proxyUrl) {
      ipcRenderer.send('set-global-proxy', { proxyUrl: this.proxyUrl });
    }
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
    
    if (sidebar.classList.contains('collapsed')) {
      sidebar.classList.remove('collapsed');
      toggleBtn.textContent = '←';
    } else {
      sidebar.classList.add('collapsed');
      toggleBtn.textContent = '☰';
    }
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
      const pageNumber = item.dest ? this.getPageNumberFromDest(item.dest) : '?';
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
    // 简单的页码提取逻辑
    if (Array.isArray(dest) && dest.length > 0) {
      const pageRef = dest[0];
      if (pageRef && pageRef.num) {
        return pageRef.num;
      }
    }
    return 1;
  }
}

// 初始化应用
document.addEventListener('DOMContentLoaded', () => {
  new PaperReader();
}); 