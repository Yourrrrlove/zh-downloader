import type { Config, VideoInfo, HistoryRecord, SiteConfig } from '@/types'
import { loadConfig, saveConfig } from '@/utils/config'
import { loadTheme } from '@/utils/theme'
import logger from '@/utils/logger'
import {
  ConfigEvent,
  SelectorEvent,
  DownloadEvent,
  ContentEvent,
  PageEvent,
  RecordType,
} from '@/utils/events'
import { STORAGE_KEYS } from '@/utils/constants'

import './content.css'

interface VideoSource {
  url: string
  quality: string
  format: string
  label: string
}

// 常量提取，减少重复
const CONSTANTS = {
  ROOT_ID: 'zhd-root',
  DATA_ATTR: 'data-zhd',
  REINIT_DELAY: 500,
  SCAN_DELAY: 500,
  QUALITY_PRIORITY: { 高清: 4, 标清: 3, 流畅: 2, 未知: 1 } as const,
  GENERIC_TITLE_SELECTORS: [
    'h1', 'h2', 'h3', '.title', '.video-title', '.media-title',
    '[title]', '[alt]', '.content-title', '.post-title'
  ],
  VIDEO_EVENTS: ['loadstart', 'loadedmetadata', 'canplay', 'play', 'loadeddata', 'progress'],
  STREAMABLE_FORMATS: ['.m3u8', 'm3u8', '.mpd', 'dash', 'blob:']
}

class UniversalVideoDownloader {
  private downloadButtons = new Set<HTMLElement>()
  private observer: MutationObserver | null = null
  private processedVideos = new WeakSet<HTMLVideoElement>()
  private config: Config | null = null
  private root: HTMLElement
  private elementSelector: {
    overlay: HTMLElement | null
    tooltip: HTMLElement | null
    currentElement: Element | null
    isActive: boolean
    isPaused: boolean // 新增：表示选择器是否暂停
    mouseMoveHandler?: (e: MouseEvent) => void
    clickHandler?: (e: MouseEvent) => void
    keyHandler?: (e: KeyboardEvent) => void
  } | null = null
  private highlightOverlay: HTMLElement | null = null
  private highlightTimeout: number | null = null
  private videoEventListeners = new WeakMap<HTMLVideoElement, () => void>()

  constructor() {
    this.root = this.createOrGetRoot()
    document.body.setAttribute(CONSTANTS.DATA_ATTR, '')
    this.init()
  }

  private createOrGetRoot(): HTMLElement {
    let root = document.querySelector(`#${CONSTANTS.ROOT_ID}`) as HTMLElement
    if (!root) {
      root = document.createElement('div')
      root.id = CONSTANTS.ROOT_ID
      document.body.appendChild(root)
    }
    return root
  }

  private async init() {
    logger.log('init() 调用。')
    await this.loadConfig()
    await this.setupTheme()
    logger.log('配置加载完成:', this.config)

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.start())
    } else {
      this.start()
    }

    // 监听消息
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      logger.log('内容脚本收到消息:', request.action)
      switch (request.action) {
        case SelectorEvent.START:
          this.startElementSelector()
          sendResponse({ success: true })
          break
        case SelectorEvent.STOP:
          this.stopElementSelector()
          sendResponse({ success: true })
          break
        case ConfigEvent.UPDATED:
          logger.log('收到 configUpdated 消息，销毁并重新初始化。')
          this.destroy()
          setTimeout(() => this.init(), CONSTANTS.REINIT_DELAY)
          sendResponse({ success: true })
          break
        case ConfigEvent.THEME_UPDATED:
          logger.log('收到 themeUpdated 消息，更新主题:', request.theme)
          this.setupTheme()
          sendResponse({ success: true })
          break
        case ContentEvent.PING:
          sendResponse({ success: true, message: 'pong' })
          break
        case ContentEvent.RELOAD:
          logger.log('Received reloadContentScript request. Destroying and re-initializing.')
          this.destroy()
          setTimeout(() => {
            this.init()
            sendResponse({ success: true })
          }, CONSTANTS.REINIT_DELAY)
          return true
        case ContentEvent.GET_VIDEO_COUNT:
          sendResponse({ videoCount: this.downloadButtons.size })
          break
        case SelectorEvent.HIGHLIGHT:
          this.highlightElement(request.selector)
          sendResponse({ success: true })
          break
        default:
          logger.warn('未知消息动作:', request.action)
          sendResponse({ success: false, error: '未知动作' })
      }
      return true
    })
  }

  private async loadConfig() {
    this.config = await loadConfig()
  }

  private async setupTheme() {
    try {
      const theme = await loadTheme()
      // 判断当前主题
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      const isDark = theme === 'dark' || (theme === 'system' && prefersDark)

      // 设置根元素主题类
      this.root.classList.toggle('dark', isDark)
      this.root.classList.toggle('light', !isDark)

      // 同时更新所有现有的工具栏和面板
      this.updateExistingElementsTheme(isDark)

      // 监听系统主题变化
      if (theme === 'system') {
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
        mediaQuery.addEventListener('change', (e) => {
          const newIsDark = e.matches
          this.root.classList.toggle('dark', newIsDark)
          this.root.classList.toggle('light', !newIsDark)
          this.updateExistingElementsTheme(newIsDark)
        })
      }
    } catch (error) {
      logger.warn('主题设置失败:', error)
    }
  }

  private updateExistingElementsTheme(isDark: boolean) {
    // 更新所有现有的工具栏
    document.querySelectorAll('.video-tools-container').forEach(container => {
      container.classList.toggle('dark', isDark)
      container.classList.toggle('light', !isDark)
    })

    // 更新所有现有的控制面板
    document.querySelectorAll('.player-control-panel').forEach(panel => {
      panel.classList.toggle('dark', isDark)
      panel.classList.toggle('light', !isDark)
    })

    // 更新所有现有的选择器弹窗
    document.querySelectorAll('.selector-type-popup').forEach(popup => {
      popup.classList.toggle('dark', isDark)
      popup.classList.toggle('light', !isDark)
    })
  }

  private async saveSelectorToConfig(
    selector: string,
    type: string,
    element: Element,
  ): Promise<boolean> {
    if (!this.config) return false

    const hostname = window.location.hostname
    let siteKey = hostname
    let isBuiltin = false

    // 查找匹配的站点配置
    for (const [site, config] of Object.entries(this.config.sites)) {
      if (hostname.includes(site)) {
        siteKey = site
        isBuiltin = config.builtin || false
        break
      }
    }

    // 如果是内置站点，询问用户是否要覆盖
    if (isBuiltin) {
      const shouldOverride = confirm(
        `检测到这是内置站点 "${siteKey}"，添加新的${type}选择器将覆盖现有配置。\n\n选择器: ${selector}\n\n是否继续？`,
      )
      if (!shouldOverride) {
        this.showSelectorMessage('已取消保存选择器。')
        return false
      }
    }

    // 如果站点不存在，创建新的站点配置
    if (!this.config.sites[siteKey]) {
      this.config.sites[siteKey] = {
        enabled: true,
        videoSelectors: [],
        titleSelectors: [],
        authorSelectors: [],
        containerSelectors: [],
        dataAttributes: [],
        builtin: false,
      }
    }

    const siteConfig = this.config.sites[siteKey]

    // 确保所有选择器数组都存在
    if (!siteConfig.videoSelectors) siteConfig.videoSelectors = []
    if (!siteConfig.titleSelectors) siteConfig.titleSelectors = []
    if (!siteConfig.authorSelectors) siteConfig.authorSelectors = []
    if (!siteConfig.containerSelectors) siteConfig.containerSelectors = []

    // 根据类型添加选择器
    switch (type) {
      case 'video':
        if (!siteConfig.videoSelectors.includes(selector)) {
          siteConfig.videoSelectors.unshift(selector) // 添加到开头
        }
        break
      case 'title':
        if (!siteConfig.titleSelectors.includes(selector)) {
          siteConfig.titleSelectors.unshift(selector)
        }
        break
      case 'author':
        if (!siteConfig.authorSelectors.includes(selector)) {
          siteConfig.authorSelectors.unshift(selector)
        }
        break
      case 'container':
        if (!siteConfig.containerSelectors.includes(selector)) {
          siteConfig.containerSelectors.unshift(selector)
        }
        break
    }

    // 保存配置
    try {
      await saveConfig(this.config)
      logger.log(`已保存${type}选择器到配置:`, selector)

      // 询问是否打开设置页面
      const openOptions = confirm(
        `${type}选择器已保存成功！\n\n选择器: ${selector}\n\n是否立即打开设置页面查看配置？`,
      )

      if (openOptions) {
        chrome.runtime.sendMessage({ action: PageEvent.OPEN_OPTIONS })
      }

      return true
    } catch (error) {
      logger.error('保存选择器配置失败:', error)
      this.showSelectorMessage('保存配置失败，请重试。')
      return false
    }
  }

  private start() {
    logger.log('start() 调用。')
    this.scanForVideos()
    this.setupObserver()
    logger.log('通用视频下载器已启动 - 当前网站:', window.location.hostname)
  }

  private setupObserver() {
    this.observer = new MutationObserver((mutations) => {
      let shouldScan = false
      mutations.forEach((mutation) => {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === 1) {
              const element = node as Element
              if (element.tagName === 'VIDEO' || element.querySelector('video')) {
                shouldScan = true
              }
            }
          })
        }
      })
      if (shouldScan) {
        logger.log('DOM 变化检测到视频元素，重新扫描。')
        setTimeout(() => this.scanForVideos(), CONSTANTS.SCAN_DELAY)
      }
    })

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
    })
  }

  private scanForVideos() {
    logger.log('scanForVideos() 调用。')
    if (!this.config) {
      logger.warn('配置未加载，跳过视频扫描。')
      return
    }

    const hostname = window.location.hostname
    const siteConfig = this.getSiteConfig(hostname)
    logger.log('当前网站配置:', siteConfig)

    if (!siteConfig || !siteConfig.enabled) {
      logger.log(`站点 ${hostname} 未启用或无配置，跳过扫描。`)
      this.updateBadgeCount(0)
      return
    }

    const selectors = siteConfig.videoSelectors || this.config.universal.videoSelectors

    selectors.forEach((selector) => {
      try {
        const elements = document.querySelectorAll(selector)
        logger.log(`选择器 "${selector}" 找到 ${elements.length} 个元素。`)
        elements.forEach((element) => this.processVideoElement(element, siteConfig))
      } catch (error) {
        logger.warn('选择器错误:', selector, error)
      }
    })

    document.querySelectorAll('video').forEach((video) => {
      this.processVideoElement(video, siteConfig)
    })

    this.updateBadgeCount(this.downloadButtons.size)
  }

  private updateBadgeCount(count: number) {
    chrome.runtime
      .sendMessage({ action: ContentEvent.GET_VIDEO_COUNT, videoCount: count })
      .catch((error) => {
        logger.warn('无法更新徽章:', error)
      })
  }

  private getSiteConfig(hostname: string): SiteConfig | null {
    if (!this.config) return null

    for (const [site, config] of Object.entries(this.config.sites)) {
      if (hostname.includes(site)) {
        return { ...this.config.universal, ...config }
      }
    }
    return this.config.universal as SiteConfig
  }

  private processVideoElement(element: Element, siteConfig: SiteConfig) {
    let videoElement = element as HTMLVideoElement
    if (element.tagName !== 'VIDEO') {
      const video = element.querySelector('video')
      if (!video) return
      videoElement = video
    }

    if (this.processedVideos.has(videoElement)) return
    this.processedVideos.add(videoElement)

    const container = this.findVideoContainer(element, siteConfig)
    if (!container) return
    if (container.querySelector('.video-tools-container')) return

    this.setupVideoEventListeners(videoElement, container, siteConfig)
    const videoInfo = this.extractVideoInfo(videoElement, container, siteConfig)
    this.createVideoTools(container, videoElement, videoInfo)
  }

  private setupVideoEventListeners(
    videoElement: HTMLVideoElement,
    container: Element,
    siteConfig: SiteConfig,
  ) {
    const updateVideoInfo = () => {
      const newVideoInfo = this.extractVideoInfo(videoElement, container, siteConfig)
      const existingToolbar = container.querySelector('.video-tools-container')
      if (existingToolbar && newVideoInfo.src) {
        this.updateVideoToolsInfo(existingToolbar as HTMLElement, newVideoInfo)
      }
    }

    const cleanup = () => {
      CONSTANTS.VIDEO_EVENTS.forEach((event) => {
        videoElement.removeEventListener(event, updateVideoInfo)
      })
    }

    CONSTANTS.VIDEO_EVENTS.forEach((event) => {
      videoElement.addEventListener(event, updateVideoInfo)
    })

    this.videoEventListeners.set(videoElement, cleanup)
  }

  private updateVideoToolsInfo(toolbar: HTMLElement, videoInfo: VideoInfo) {
    const downloadBtn = toolbar.querySelector('.download-btn') as HTMLButtonElement
    const screenshotBtn = toolbar.querySelector('.screenshot-btn') as HTMLButtonElement

    if (downloadBtn) {
      downloadBtn.disabled = videoInfo.isStreamable && !videoInfo.src
      downloadBtn.title = videoInfo.isStreamable
        ? '此视频可能无法直接下载 (流媒体)'
        : `下载视频: ${videoInfo.title}`

      const tooltip = downloadBtn.querySelector('.video-tool-tooltip') as HTMLElement
      if (tooltip) {
        tooltip.textContent = videoInfo.isStreamable ? '流媒体视频，可能无法直接下载' : '下载视频'
      }
    }

    if (screenshotBtn) {
      screenshotBtn.title = `截图: ${videoInfo.title}`
    }
  }

  private findVideoContainer(element: Element, siteConfig: SiteConfig): Element | null {
    let container: Element | null = element

    // 优先使用站点配置的容器选择器
    if (siteConfig.containerSelectors) {
      for (const selector of siteConfig.containerSelectors) {
        const specificContainer = element.closest(selector)
        if (specificContainer) {
          logger.log('通过站点容器选择器找到容器:', selector)
          return specificContainer
        }
      }
    }

    // 回退到通用容器查找逻辑
    while (container && container !== document.body) {
      const style = window.getComputedStyle(container)
      const rect = container.getBoundingClientRect()

      if (
        (style.position === 'relative' || style.position === 'absolute') &&
        rect.width > 200 &&
        rect.height > 150
      ) {
        logger.log('通过通用逻辑找到容器:', container)
        return container
      }
      container = container.parentElement
    }

    return element.parentElement || element
  }

  private extractVideoInfo(
    videoElement: HTMLVideoElement,
    container: Element,
    siteConfig: SiteConfig,
  ): VideoInfo {
    const info: VideoInfo = {
      src: '',
      title: '视频',
      quality: 'unknown',
      format: 'mp4',
      isStreamable: false,
    }

    // 获取视频源
    const videoSources = this.getVideoSources(videoElement)
    if (videoSources.length > 0) {
      const bestSource = this.selectBestVideoSource(videoSources)
      info.src = bestSource.url
      info.quality = bestSource.quality
      info.format = bestSource.format
    }

    // 通用标题提取
    info.title = this.getVideoTitle(videoElement, container, siteConfig)

    // 检查是否为流媒体
    if (info.src) {
      info.isStreamable = CONSTANTS.STREAMABLE_FORMATS.some(format => info.src.includes(format))
    }

    return info
  }

  private getVideoSources(videoElement: HTMLVideoElement): VideoSource[] {
    const sources: VideoSource[] = []

    // 主要src属性
    if (videoElement.src && videoElement.src !== window.location.href) {
      sources.push({
        url: videoElement.src,
        quality: this.detectQuality(videoElement.src),
        format: this.detectFormat(videoElement.src),
        label: `主源 (${this.detectQuality(videoElement.src)})`,
      })
    }

    // 当前src
    if (
      videoElement.currentSrc &&
      videoElement.currentSrc !== window.location.href &&
      videoElement.currentSrc !== videoElement.src
    ) {
      sources.push({
        url: videoElement.currentSrc,
        quality: this.detectQuality(videoElement.currentSrc),
        format: this.detectFormat(videoElement.currentSrc),
        label: `当前源 (${this.detectQuality(videoElement.currentSrc)})`,
      })
    }

    // source子元素
    const sourceElements = videoElement.querySelectorAll('source')
    sourceElements.forEach((source, index) => {
      if (source.src) {
        sources.push({
          url: source.src,
          quality: this.detectQuality(source.src, source.getAttribute('data-quality')),
          format: this.detectFormat(source.src, source.type),
          label: `源${index + 1} (${this.detectQuality(source.src, source.getAttribute('data-quality'))})`,
        })
      }
    })

    // 去重
    const uniqueSources = sources.filter(
      (source, index, self) => index === self.findIndex((s) => s.url === source.url),
    )
    return uniqueSources
  }

  private detectQuality(url: string, dataQuality?: string | null): string {
    if (dataQuality) return dataQuality

    if (url.includes('1080') || url.includes('hd')) return '高清'
    if (url.includes('720')) return '标清'
    if (url.includes('480') || url.includes('sd')) return '流畅'
    if (url.includes('360')) return '极速'

    const bitrateMatch = url.match(/(\d+)k/i)
    if (bitrateMatch) {
      const bitrate = Number.parseInt(bitrateMatch[1])
      if (bitrate > 2000) return '高清'
      if (bitrate > 1000) return '标清'
      return '流畅'
    }

    return '未知'
  }

  private detectFormat(url: string, mimeType?: string | null): string {
    if (mimeType) {
      if (mimeType.includes('mp4')) return 'mp4'
      if (mimeType.includes('webm')) return 'webm'
      if (mimeType.includes('ogg')) return 'ogg'
    }

    if (url.includes('.webm')) return 'webm'
    if (url.includes('.ogg')) return 'ogg'
    if (url.includes('.mov')) return 'mov'
    return 'mp4'
  }

  private selectBestVideoSource(sources: VideoSource[]): VideoSource {
    return sources.reduce((best, current) => {
      const bestPriority = CONSTANTS.QUALITY_PRIORITY[best.quality as keyof typeof CONSTANTS.QUALITY_PRIORITY] || 1
      const currentPriority = CONSTANTS.QUALITY_PRIORITY[current.quality as keyof typeof CONSTANTS.QUALITY_PRIORITY] || 1
      return currentPriority > bestPriority ? current : best
    })
  }

  // 通用标题提取方法 - 通过配置驱动
  private getVideoTitle(
    videoElement: HTMLVideoElement,
    container: Element,
    siteConfig: SiteConfig,
  ): string {
    let title = ''
    let author = ''

    // 1. 尝试从数据属性提取信息（如知乎的data-zop）
    if (siteConfig.dataAttributes) {
      for (const attr of siteConfig.dataAttributes) {
        const element = container.closest(`[${attr}]`)
        if (element) {
          try {
            const dataValue = element.getAttribute(attr)
            if (dataValue) {
              const data = JSON.parse(dataValue)
              if (data.title) title = data.title
              if (data.authorName) author = data.authorName
              logger.log(`从 ${attr} 属性提取信息:`, { title, author })
              break
            }
          } catch (error) {
            logger.warn(`解析 ${attr} 属性失败:`, error)
          }
        }
      }
    }

    // 2. 使用配置的标题选择器
    if (!title && siteConfig.titleSelectors) {
      title = this.extractTextBySelectors(container, siteConfig.titleSelectors, '标题')
    }

    // 3. 使用配置的作者选择器
    if (!author && siteConfig.authorSelectors) {
      author = this.extractTextBySelectors(container, siteConfig.authorSelectors, '作者')
    }

    // 4. 通用回退逻辑
    if (!title) {
      title = this.extractTextBySelectors(container, CONSTANTS.GENERIC_TITLE_SELECTORS, '通用标题')
    }

    // 5. 最后回退到页面标题
    if (!title && document.title) {
      title = document.title.substring(0, 30)
    }

    // 清理标题
    title =
      title
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, ' ')
        .trim() || '视频'

    const siteName = this.getSiteName(window.location.hostname)

    // 组合最终标题
    if (author) {
      return `${title}_${author}_${siteName}`
    } else {
      return `${title}_${siteName}`
    }
  }

  // 通用文本提取方法
  private extractTextBySelectors(container: Element, selectors: string[], type: string): string {
    let searchContainer: Element | null = container
    let searchLevel = 0

    while (searchContainer && searchLevel < 10) {
      for (const selector of selectors) {
        try {
          const element = searchContainer.querySelector(selector)
          if (element) {
            const text = element.textContent?.trim()
            if (text && text.length > 1) {
              logger.log(`通过${type}选择器 "${selector}" 找到:`, text)
              return text.substring(0, 50)
            }
          }
        } catch (error) {
          logger.warn(`${type}选择器 "${selector}" 出错:`, error)
        }
      }
      searchContainer = searchContainer.parentElement
      searchLevel++
    }

    return ''
  }

  // 优化站点名称提取
  private getSiteName(hostname: string): string {
    const cleanHostname = hostname.replace(/^www\./, '')
    const parts = cleanHostname.split('.')
    if (parts.length >= 2) {
      return parts[0]
    }
    return cleanHostname
  }

  // 1. 工具栏按钮组美化（在 createVideoTools 里）
  private createVideoTools(
    container: Element,
    videoElement: HTMLVideoElement,
    videoInfo: VideoInfo,
  ) {
    // 让视频父容器为定位元素，方便绝对定位
    const videoContainer = container as HTMLElement
    if (getComputedStyle(videoContainer).position === 'static') {
      videoContainer.style.position = 'relative'
    }

    // 创建工具栏容器
    const toolsContainer = document.createElement('div')
    toolsContainer.className = 'video-tools-container'

    // 主题 class
    const isDark = this.root.classList.contains('dark')
    toolsContainer.classList.toggle('dark', isDark)
    toolsContainer.classList.toggle('light', !isDark)

    // 创建按钮
    const playerControlBtn = this.createPlayerControlButton(videoElement, videoInfo)
    playerControlBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      const existingPanel = document.querySelector('.player-control-panel') as HTMLElement
      if (existingPanel) {
        existingPanel.remove()
      } else {
        this.showPlayerControls(playerControlBtn, videoElement)
      }
    })
    toolsContainer.appendChild(playerControlBtn)

    const screenshotBtn = this.createScreenshotButton(videoElement, videoInfo)
    toolsContainer.appendChild(screenshotBtn)

    const videoSources = this.getVideoSources(videoElement)
    if (videoSources.length > 1) {
      const qualityBtn = this.createQualitySelectButton(videoElement, videoSources, videoInfo)
      toolsContainer.appendChild(qualityBtn)
    } else {
      const downloadBtn = this.createDownloadButton(videoInfo)
      toolsContainer.appendChild(downloadBtn)
    }

    videoContainer.appendChild(toolsContainer)

    this.downloadButtons.add(toolsContainer)
    this.updateBadgeCount(this.downloadButtons.size)
  }

  private createPlayerControlButton(
    videoElement: HTMLVideoElement,
    videoInfo: VideoInfo,
  ): HTMLButtonElement {
    const button = document.createElement('button')
    button.className = 'video-tool-btn player-control-btn'
    button.title = '播放器控制'

    // 调试：确保按钮有正确的类名
    logger.log('创建播放器控制按钮，类名:', button.className)

    const tooltip = document.createElement('div')
    tooltip.className = 'video-tool-tooltip'
    tooltip.textContent = '播放器控制'
    button.appendChild(tooltip)

    button.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation() // 阻止事件冒泡到微博播放器
      this.showPlayerControls(button, videoElement)
    })

    this.addButtonHoverEffects(button)
    return button
  }

  private showPlayerControls(button: HTMLButtonElement, videoElement: HTMLVideoElement) {
    // 所在工具栏容器
    const currentToolsContainer = button.closest('.video-tools-container') as HTMLElement
    if (!currentToolsContainer) return

    // 已存在则移除
    const existingPanel = currentToolsContainer.parentElement?.querySelector(
      '.player-control-panel',
    ) as HTMLElement
    if (existingPanel) {
      existingPanel.remove()
      return
    }

    const controlPanel = document.createElement('div')
    controlPanel.className = 'player-control-panel'

    // 主题支持
    const isDark = this.root.classList.contains('dark')
    controlPanel.classList.add(isDark ? 'dark' : 'light')

    // 监听主题变化
    const themeObserver = new MutationObserver(() => {
      controlPanel.classList.toggle('dark', this.root.classList.contains('dark'))
      controlPanel.classList.toggle('light', !this.root.classList.contains('dark'))
    })
    themeObserver.observe(this.root, {
      attributes: true,
      attributeFilter: ['class'],
    })
      ; (controlPanel as any)._themeObserver = themeObserver

    controlPanel.innerHTML = `
      <div class="actions-row">
        <button class="icon-btn flip-h-btn" title="水平翻转"></button>
        <button class="icon-btn flip-v-btn" title="垂直翻转"></button>
        <button class="icon-btn pip-btn" title="画中画PIP"></button>
      </div>
      <div class="scrollable">
        <div class="control-row speed-row">
          <span class="slider-label">速度</span>
          <input type="range" min="0.25" max="3" step="0.05" value="${videoElement.playbackRate}" class="speed-slider">
          <span class="slider-value">${videoElement.playbackRate}x</span>
        </div>
        <div class="control-row volume-row">
          <span class="slider-label">音量</span>
          <input type="range" min="0" max="1" step="0.01" value="${videoElement.volume}" class="volume-slider">
          <span class="slider-value">${Math.round(videoElement.volume * 100)}%</span>
        </div>
        <div class="control-row rotate-row">
          <span class="slider-label">旋转</span>
          <input type="range" min="0" max="360" step="1" value="0" class="rotate-slider">
          <span class="slider-value">0°</span>
        </div>
        <div class="control-row brightness-row">
          <span class="slider-label">亮度</span>
          <input type="range" min="0.5" max="2" step="0.01" value="1" class="brightness-slider">
          <span class="slider-value">1.00</span>
        </div>
        <div class="control-row contrast-row">
          <span class="slider-label">对比度</span>
          <input type="range" min="0.5" max="2" step="0.01" value="1" class="contrast-slider">
          <span class="slider-value">1.00</span>
        </div>
        <div class="control-row grayscale-row">
          <span class="slider-label">灰度</span>
          <input type="range" min="0" max="1" step="0.01" value="0" class="grayscale-slider">
          <span class="slider-value">0</span>
        </div>
        <div class="control-row blur-row">
          <span class="slider-label">模糊</span>
          <input type="range" min="0" max="5" step="0.1" value="0" class="blur-slider">
          <span class="slider-value">0</span>
        </div>
        <div class="control-row hue-row">
          <span class="slider-label">色相</span>
          <input type="range" min="0" max="360" step="1" value="0" class="hue-slider">
          <span class="slider-value">0</span>
        </div>
      </div>
    `

    // 定位面板到工具栏下方，右侧与下载按钮对齐
    const playerControlBtn = currentToolsContainer.querySelector(
      '.player-control-btn',
    ) as HTMLElement
    const downloadBtn = currentToolsContainer.querySelector('.download-btn') as HTMLElement
    const updatePanelPosition = () => {
      const toolbarTop = currentToolsContainer.offsetTop
      const toolbarHeight = currentToolsContainer.offsetHeight
      const panelWidth = controlPanel.offsetWidth || 320
      let panelLeft = playerControlBtn.offsetLeft
      if (downloadBtn) {
        const btnRight = downloadBtn.offsetLeft + downloadBtn.offsetWidth
        panelLeft = btnRight - panelWidth
        if (panelLeft < 0) panelLeft = 0
      }
      controlPanel.style.position = 'absolute'
      controlPanel.style.top = `${toolbarTop + toolbarHeight + 8}px`
      //  controlPanel.style.left = `${panelLeft}px`
      controlPanel.style.zIndex = '1000002'
      controlPanel.style.pointerEvents = 'auto'
      controlPanel.style.width = 'max-content'
      controlPanel.style.minWidth = '320px'
      controlPanel.style.minHeight = '200px'
      // controlPanel.style.maxHeight = '35vh';
      controlPanel.style.overflowY = 'auto'
      controlPanel.style.padding = '20px 16px 16px 16px'
    }
    requestAnimationFrame(updatePanelPosition)

    // 主题切换时同步 shadowRoot 内所有相关元素的 class
    const syncThemeClass = () => {
      const isDark = this.root.classList.contains('dark')
      const containers = currentToolsContainer.parentElement?.querySelectorAll(
        '.video-tools-container, .player-control-panel',
      ) as NodeListOf<HTMLElement>
      containers.forEach((el) => {
        el.classList.toggle('dark', isDark)
        el.classList.toggle('light', !isDark)
      })
    }
    // 初始同步
    syncThemeClass()
    // 监听主题变化
    const themeObserverPanel = new MutationObserver(() => {
      syncThemeClass()
    })
    themeObserverPanel.observe(this.root, {
      attributes: true,
      attributeFilter: ['class'],
    })
      ; (controlPanel as any)._themeObserver = themeObserverPanel
    // 销毁时断开 observer
    const oldRemove = controlPanel.remove.bind(controlPanel)
    controlPanel.remove = () => {
      if ((controlPanel as any)._themeObserver) (controlPanel as any)._themeObserver.disconnect()
      oldRemove()
    }

    currentToolsContainer.parentElement?.appendChild(controlPanel)

    // 变量提升，确保所有函数可访问且只声明一次
    let currentScale = 1
    let currentRotate = 0
    let flipH = false
    let flipV = false
    const speedSlider = controlPanel.querySelector('.speed-slider') as HTMLInputElement
    const speedValue = speedSlider?.parentElement?.querySelector('.slider-value') as HTMLElement
    const volumeSlider = controlPanel.querySelector('.volume-slider') as HTMLInputElement
    const volumeValue = volumeSlider?.parentElement?.querySelector('.slider-value') as HTMLElement
    const zoomSlider = controlPanel.querySelector('.zoom-slider') as HTMLInputElement
    const zoomValue = zoomSlider?.parentElement?.querySelector('.slider-value') as HTMLElement
    const brightnessSlider = controlPanel.querySelector('.brightness-slider') as HTMLInputElement
    const brightnessValue = brightnessSlider?.parentElement?.querySelector(
      '.slider-value',
    ) as HTMLElement
    const contrastSlider = controlPanel.querySelector('.contrast-slider') as HTMLInputElement
    const contrastValue = contrastSlider?.parentElement?.querySelector(
      '.slider-value',
    ) as HTMLElement
    const grayscaleSlider = controlPanel.querySelector('.grayscale-slider') as HTMLInputElement
    const grayscaleValue = grayscaleSlider?.parentElement?.querySelector(
      '.slider-value',
    ) as HTMLElement
    const blurSlider = controlPanel.querySelector('.blur-slider') as HTMLInputElement
    const blurValue = blurSlider?.parentElement?.querySelector('.slider-value') as HTMLElement
    const hueSlider = controlPanel.querySelector('.hue-slider') as HTMLInputElement
    const hueValue = hueSlider?.parentElement?.querySelector('.slider-value') as HTMLElement
    // 事件绑定
    if (speedSlider && speedValue) {
      speedSlider.addEventListener('input', (e) => {
        e.stopPropagation()
        const speed = Number.parseFloat(speedSlider.value)
        videoElement.playbackRate = speed
        speedValue.textContent = `${speed}x`
      })
    }
    if (volumeSlider && volumeValue) {
      volumeSlider.addEventListener('input', (e) => {
        e.stopPropagation()
        const volume = Number.parseFloat(volumeSlider.value)
        videoElement.volume = volume
        volumeValue.textContent = `${Math.round(volume * 100)}%`
      })
    }
    if (zoomSlider && zoomValue) {
      zoomSlider.addEventListener('input', (e) => {
        e.stopPropagation()
        currentScale = Number.parseFloat(zoomSlider.value)
        zoomValue.textContent = `${currentScale.toFixed(2)}x`
        updateTransform()
      })
    }
    function updateTransform() {
      let transform = `scale(${currentScale}) rotate(${currentRotate}deg)`
      if (flipH) transform += ' scaleX(-1)'
      if (flipV) transform += ' scaleY(-1)'
      videoElement.style.transform = transform
    }

    // 旋转滑块绑定
    const rotateSlider = controlPanel.querySelector('.rotate-slider') as HTMLInputElement
    const rotateValue = rotateSlider.parentElement?.querySelector('.slider-value') as HTMLElement
    rotateSlider.addEventListener('input', (e) => {
      e.stopPropagation()
      currentRotate = Number(rotateSlider.value)
      if (rotateValue) rotateValue.textContent = `${currentRotate}°`
      updateTransform()
    })

    // 翻转按钮
    const flipHBtn = controlPanel.querySelector('.flip-h-btn') as HTMLButtonElement
    const flipVBtn = controlPanel.querySelector('.flip-v-btn') as HTMLButtonElement
    flipHBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      flipH = !flipH
      updateTransform()
      flipHBtn.classList.toggle('active', flipH)
    })
    flipVBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      flipV = !flipV
      updateTransform()
      flipVBtn.classList.toggle('active', flipV)
    })

    // 旋转按钮
    controlPanel.querySelectorAll('.rotate-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const deg = Number(btn.getAttribute('data-rotation')) || 0
        currentRotate = deg
        updateTransform()
      })
    })

    // 组合滤镜
    const filterState: Record<string, number> = {
      brightness: 1,
      contrast: 1,
      grayscale: 0,
      blur: 0,
      'hue-rotate': 0,
    }
    const updateFilter = () => {
      const f = [
        `brightness(${filterState.brightness})`,
        `contrast(${filterState.contrast})`,
        `grayscale(${filterState.grayscale})`,
        `blur(${filterState.blur}px)`,
        `hue-rotate(${filterState['hue-rotate']}deg)`,
      ].join(' ')
      videoElement.style.filter = f
    }

    // PIP 按钮
    const pipBtn = controlPanel.querySelector('.pip-btn') as HTMLButtonElement
    if (videoElement.requestPictureInPicture) {
      function updatePipBtn() {
        pipBtn.classList.toggle('active', !!document.pictureInPictureElement)
      }
      pipBtn.addEventListener('click', async (e) => {
        e.stopPropagation()
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture()
        } else {
          await videoElement.requestPictureInPicture()
        }
        updatePipBtn()
      })
      videoElement.addEventListener('enterpictureinpicture', updatePipBtn)
      videoElement.addEventListener('leavepictureinpicture', updatePipBtn)
      updatePipBtn()
    } else {
      pipBtn.disabled = true
      pipBtn.title = 'PIP不支持'
    }

    // 点击外部关闭面板
    const closePanel = (e: MouseEvent) => {
      if (!controlPanel.contains(e.target as Node) && !button.contains(e.target as Node)) {
        controlPanel.remove()
        document.removeEventListener('click', closePanel)
      }
    }
    // 优化面板插入逻辑
    const toolsContainer = button.closest('.video-tools-container')
    if (toolsContainer && toolsContainer.parentNode) {
      toolsContainer.parentNode.appendChild(controlPanel)
    } else {
      document.body.appendChild(controlPanel)
    }
    setTimeout(() => document.addEventListener('click', closePanel), 100)

    if (brightnessSlider && brightnessValue) {
      brightnessSlider.addEventListener('input', () => {
        filterState.brightness = Number(brightnessSlider.value)
        brightnessValue.textContent = String(Number(brightnessSlider.value).toFixed(2))
        updateFilter()
      })
    }
    if (contrastSlider && contrastValue) {
      contrastSlider.addEventListener('input', () => {
        filterState.contrast = Number(contrastSlider.value)
        contrastValue.textContent = String(Number(contrastSlider.value).toFixed(2))
        updateFilter()
      })
    }
    if (grayscaleSlider && grayscaleValue) {
      grayscaleSlider.addEventListener('input', () => {
        filterState.grayscale = Number(grayscaleSlider.value)
        grayscaleValue.textContent = String(grayscaleSlider.value)
        updateFilter()
      })
    }
    if (blurSlider && blurValue) {
      blurSlider.addEventListener('input', () => {
        filterState.blur = Number(blurSlider.value)
        blurValue.textContent = String(blurSlider.value)
        updateFilter()
      })
    }
    if (hueSlider && hueValue) {
      hueSlider.addEventListener('input', () => {
        filterState['hue-rotate'] = Number(hueSlider.value)
        hueValue.textContent = String(hueSlider.value)
        updateFilter()
      })
    }
  }

  private createQualitySelectButton(
    videoElement: HTMLVideoElement,
    sources: VideoSource[],
    videoInfo: VideoInfo,
  ): HTMLButtonElement {
    const button = document.createElement('button')
    button.className = 'video-tool-btn quality-select-btn'
    button.title = '选择画质下载'

    const tooltip = document.createElement('div')
    tooltip.className = 'video-tool-tooltip'
    tooltip.textContent = '选择画质'
    button.appendChild(tooltip)

    button.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      this.showQualityMenu(button, sources, videoInfo)
    })

    this.addButtonHoverEffects(button)
    return button
  }

  private showQualityMenu(button: HTMLButtonElement, sources: VideoSource[], videoInfo: VideoInfo) {
    // 移除已存在的菜单
    const existingMenu = document.querySelector('.quality-menu')
    if (existingMenu) {
      existingMenu.remove()
    }

    const menu = document.createElement('div')
    menu.className = 'quality-menu'

    sources.forEach((source) => {
      const item = document.createElement('button')
      item.textContent = `${source.label} (${source.format.toUpperCase()})`

      item.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()

        const downloadInfo = {
          ...videoInfo,
          src: source.url,
          quality: source.quality,
          format: source.format,
        }

        this.downloadVideo(button, downloadInfo)
        menu.remove()
      })

      menu.appendChild(item)
    })

    const closeMenu = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node) && !button.contains(e.target as Node)) {
        menu.remove()
        document.removeEventListener('click', closeMenu)
      }
    }

    button.parentElement?.appendChild(menu)
    setTimeout(() => document.addEventListener('click', closeMenu), 100)
  }

  private createScreenshotButton(
    videoElement: HTMLVideoElement,
    videoInfo: VideoInfo,
  ): HTMLButtonElement {
    const button = document.createElement('button')
    button.className = 'video-tool-btn screenshot-btn'
    button.title = `截图: ${videoInfo.title}`

    // 调试：确保按钮有正确的类名
    logger.log('创建截图按钮，类名:', button.className)

    const tooltip = document.createElement('div')
    tooltip.className = 'video-tool-tooltip'
    tooltip.textContent = '截取当前帧'
    button.appendChild(tooltip)

    button.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      this.captureVideoFrame(button, videoElement, videoInfo)
    })

    this.addButtonHoverEffects(button)
    return button
  }

  private createDownloadButton(videoInfo: VideoInfo): HTMLButtonElement {
    const button = document.createElement('button')
    button.className = 'video-tool-btn download-btn'
    button.title = videoInfo.isStreamable
      ? '此视频可能无法直接下载 (流媒体)'
      : `下载视频: ${videoInfo.title}`

    // 调试：确保按钮有正确的类名
    logger.log('创建下载按钮，类名:', button.className)
    button.disabled = videoInfo.isStreamable && !videoInfo.src

    const tooltip = document.createElement('div')
    tooltip.className = 'video-tool-tooltip'
    tooltip.textContent = videoInfo.isStreamable ? '流媒体视频，可能无法直接下载' : '下载视频'
    button.appendChild(tooltip)

    button.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      if (!videoInfo.isStreamable) {
        this.downloadVideo(button, videoInfo)
      } else {
        // 对于流媒体，提供通用提示
        const hostname = window.location.hostname
        let message = '此视频为流媒体格式，可能无法直接下载。'

        if (hostname.includes('douyin.com')) {
          message += '\n\n建议：\n1. 使用专业的抖音下载工具\n2. 或者尝试截图功能保存关键帧'
        } else {
          message += '\n\n建议：\n1. 使用专业下载工具\n2. 或者尝试截图功能'
        }

        alert(message)
      }
    })

    this.addButtonHoverEffects(button)
    return button
  }

  private addButtonHoverEffects(button: HTMLButtonElement) {
    button.addEventListener('mouseenter', () => {
      if (!button.classList.contains('loading')) {
        button.classList.add('pulse')
      }
    })
    button.addEventListener('mouseleave', () => {
      button.classList.remove('pulse')
    })
  }

  private formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = Math.floor(seconds % 60)

    if (hours > 0) {
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    } else {
      return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    }
  }

  private isBlankScreenshot(canvas: HTMLCanvasElement): boolean {
    const ctx = canvas.getContext('2d')
    if (!ctx) return false

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const data = imageData.data

    let whitePixels = 0
    let transparentPixels = 0
    const totalPixels = data.length / 4

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const a = data[i + 3]

      if (r > 240 && g > 240 && b > 240) {
        whitePixels++
      }
      if (a < 10) {
        transparentPixels++
      }
    }

    const blankRatio = (whitePixels + transparentPixels) / totalPixels
    return blankRatio > 0.95
  }

  private async captureVideoFrame(
    button: HTMLButtonElement,
    videoElement: HTMLVideoElement,
    videoInfo: VideoInfo,
  ) {
    if (button.classList.contains('loading')) return

    button.classList.add('loading')
    const tooltip = button.querySelector('.video-tool-tooltip') as HTMLElement
    tooltip.textContent = '正在截图...'

    try {
      // 等待视频加载完成
      if (videoElement.readyState < 2) {
        // 等待视频加载
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('视频加载超时，请确保视频正在播放'))
          }, 5000) // 5秒超时

          const handleCanPlay = () => {
            clearTimeout(timeout)
            videoElement.removeEventListener('canplay', handleCanPlay)
            videoElement.removeEventListener('error', handleError)
            resolve()
          }

          const handleError = () => {
            clearTimeout(timeout)
            videoElement.removeEventListener('canplay', handleCanPlay)
            videoElement.removeEventListener('error', handleError)
            reject(new Error('视频加载失败'))
          }

          videoElement.addEventListener('canplay', handleCanPlay)
          videoElement.addEventListener('error', handleError)
        })
      }

      const currentTime = videoElement.currentTime
      const formattedTime = this.formatTime(currentTime)

      if (videoElement.crossOrigin !== 'anonymous') {
        videoElement.crossOrigin = 'anonymous'
        await new Promise<void>((resolve) => {
          const handleLoad = () => {
            videoElement.removeEventListener('loadeddata', handleLoad)
            resolve()
          }
          videoElement.addEventListener('loadeddata', handleLoad)
          videoElement.load()
        })
      }

      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('无法创建canvas上下文')

      canvas.width = videoElement.videoWidth || videoElement.clientWidth
      canvas.height = videoElement.videoHeight || videoElement.clientHeight

      if (canvas.width === 0 || canvas.height === 0) {
        throw new Error('无法获取视频尺寸，请确保视频正在播放')
      }

      // 应用当前视频的滤镜效果到canvas
      const currentFilter = videoElement.style.filter
      const currentTransform = videoElement.style.transform

      if (currentFilter || currentTransform) {
        // 创建临时canvas来应用滤镜效果
        const tempCanvas = document.createElement('canvas')
        const tempCtx = tempCanvas.getContext('2d')
        if (tempCtx) {
          tempCanvas.width = canvas.width
          tempCanvas.height = canvas.height

          // 先绘制到临时canvas
          tempCtx.drawImage(videoElement, 0, 0, canvas.width, canvas.height)

          // 应用滤镜和变换
          if (currentFilter) {
            ctx.filter = currentFilter
          }
          if (currentTransform) {
            // 解析transform字符串并应用到canvas
            const transformMatch = currentTransform.match(/rotate\(([^)]+)\)/)
            if (transformMatch) {
              const angle = transformMatch[1]
              const radians = (parseFloat(angle) * Math.PI) / 180
              ctx.translate(canvas.width / 2, canvas.height / 2)
              ctx.rotate(radians)
              ctx.translate(-canvas.width / 2, -canvas.height / 2)
            }
          }

          // 从临时canvas绘制到最终canvas
          ctx.drawImage(tempCanvas, 0, 0)
        } else {
          // 如果无法创建临时canvas，直接绘制
          ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height)
        }
      } else {
        // 没有滤镜效果，直接绘制
        ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height)
      }

      // 检查截图是否为空，但给一些容错空间
      if (this.isBlankScreenshot(canvas)) {
        // 如果检测到空白，等待一小段时间后重试一次
        await new Promise((resolve) => setTimeout(resolve, 500))

        // 重新绘制
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height)

        // 再次检查
        if (this.isBlankScreenshot(canvas)) {
          throw new Error('检测到空白截图！请确保视频正在播放且有内容显示。')
        }
      }

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) {
            resolve(blob)
          } else {
            reject(new Error('无法生成截图'))
          }
        }, 'image/png')
      })

      const url = URL.createObjectURL(blob)
      const filename = `${videoInfo.title}_screenshot_${formattedTime.replace(/:/g, '-')}_${Date.now()}.png`

      const chromeApiResponse = await this.downloadWithChromeAPI({
        src: url,
        title: filename,
        quality: 'screenshot',
        format: 'png',
        isStreamable: false,
      })

      setTimeout(() => URL.revokeObjectURL(url), 1000)

      button.classList.remove('loading')
      button.classList.add('success')

      await this.recordHistory({
        type: RecordType.SCREENSHOT,
        title: videoInfo.title,
        domain: window.location.hostname,
        url: window.location.href,
        videoSrc: videoElement.src || videoElement.currentSrc || '',
        timestamp: Date.now(),
        format: 'png',
        fileSize: blob.size,
        downloadId: chromeApiResponse.downloadId,
        screenshotTime: formattedTime,
        screenshotSeconds: currentTime,
      })

      tooltip.textContent = `截图成功！(${formattedTime})`

      setTimeout(() => {
        button.classList.remove('success')
        tooltip.textContent = '截取当前帧'
      }, 3000)
    } catch (error) {
      button.classList.remove('loading')
      button.classList.add('error')
      tooltip.textContent = '截图失败'

      alert(`截图失败: ${(error as Error).message}`)

      setTimeout(() => {
        button.classList.remove('error')
        tooltip.textContent = '截取当前帧'
      }, 3000)
    }
  }

  private async downloadVideo(button: HTMLButtonElement, videoInfo: VideoInfo) {
    if (button.classList.contains('loading')) return

    button.classList.add('loading')
    const tooltip = button.querySelector('.video-tool-tooltip') as HTMLElement
    tooltip.textContent = '正在下载...'

    try {
      if (!videoInfo.src.startsWith('http') && !videoInfo.src.startsWith('blob:')) {
        throw new Error('无效的视频链接')
      }

      const chromeApiResponse = await this.downloadWithChromeAPI(videoInfo)
      button.classList.remove('loading')
      button.classList.add('success')
      tooltip.textContent = '下载已开始！'

      await this.recordHistory({
        type: RecordType.VIDEO,
        title: videoInfo.title,
        domain: window.location.hostname,
        url: window.location.href,
        videoSrc: videoInfo.src,
        timestamp: Date.now(),
        format: videoInfo.format,
        fileSize: undefined,
        downloadId: chromeApiResponse.downloadId,
      })

      setTimeout(() => {
        button.classList.remove('success')
        tooltip.textContent = '下载视频'
      }, 2000)
    } catch (error) {
      button.classList.remove('loading')
      button.classList.add('error')
      tooltip.textContent = '下载失败'
      logger.error(`[downloadVideo] ${videoInfo.title} ${videoInfo.src} failed: ${error}`)

      setTimeout(() => {
        button.classList.remove('error')
        tooltip.textContent = '下载视频'
      }, 3000)
    }
  }

  private async downloadWithChromeAPI(videoInfo: VideoInfo): Promise<any> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          action: DownloadEvent.START,
          url: videoInfo.src,
          filename: `${videoInfo.title}.${videoInfo.format}`,
        },
        (response) => {
          if (response && response.success) {
            resolve(response)
          } else {
            reject(new Error(response?.error || 'Chrome API下载失败'))
          }
        },
      )
    })
  }

  private async recordHistory(record: HistoryRecord) {
    try {
      const result = await chrome.storage.local.get([STORAGE_KEYS.DOWNLOAD_HISTORY])
      let history: HistoryRecord[] = result[STORAGE_KEYS.DOWNLOAD_HISTORY] || []

      history.unshift(record)

      if (history.length > 500) {
        history = history.slice(0, 500)
      }

      await chrome.storage.local.set({ [STORAGE_KEYS.DOWNLOAD_HISTORY]: history })
    } catch (error) {
      logger.warn('保存历史记录失败:', error)
    }
  }

  // 统一元素选择器功能
  public startElementSelector() {
    if (this.elementSelector && this.elementSelector.isActive) return // 如果已经激活，则不重复启动

    this.elementSelector = {
      overlay: null,
      tooltip: null,
      currentElement: null,
      isActive: true,
      isPaused: false,
    }

    // 选择器相关样式已移至 content.css，无需动态注入

    this.elementSelector.tooltip = document.createElement('div')
    this.elementSelector.tooltip.className = 'element-selector-tooltip'
    this.root.appendChild(this.elementSelector.tooltip) // 替换 this.root

    this.elementSelector.mouseMoveHandler = (e) => this.handleElementSelectorMouseMove(e)
    this.elementSelector.clickHandler = (e) => this.handleElementSelectorClick(e)
    this.elementSelector.keyHandler = (e) => this.handleElementSelectorKey(e)

    document.addEventListener('mousemove', this.elementSelector.mouseMoveHandler)
    document.addEventListener('click', this.elementSelector.clickHandler, true)
    document.addEventListener('keydown', this.elementSelector.keyHandler)

    this.showSelectorMessage(
      '元素选择模式已激活\n• 鼠标悬停预览元素\n• 点击选择元素\n• 按 ESC 退出',
    )

    // 确保 highlight-overlay 插入主文档
    if (!document.querySelector('.highlight-overlay')) {
      this.highlightOverlay = document.createElement('div')
      this.highlightOverlay.className = 'highlight-overlay'
      document.body.appendChild(this.highlightOverlay)
    }
  }

  private handleElementSelectorMouseMove(e: MouseEvent) {
    if (!this.elementSelector?.isActive || this.elementSelector.isPaused) return

    let element = document.elementFromPoint(e.clientX, e.clientY)
    // 若命中遮罩或高亮框，暂时隐藏后再取一次
    if (
      element === this.elementSelector.overlay ||
      element === this.highlightOverlay ||
      element?.classList.contains('element-selector-overlay')
    ) {
      if (this.elementSelector.overlay) this.elementSelector.overlay.style.display = 'none'
      if (this.highlightOverlay) this.highlightOverlay.style.display = 'none'
      element = document.elementFromPoint(e.clientX, e.clientY)
      if (this.elementSelector.overlay) this.elementSelector.overlay.style.display = 'block'
      if (this.highlightOverlay) this.highlightOverlay.style.display = 'block'
    }

    if (!element || element === this.elementSelector.currentElement) return

    this.elementSelector.currentElement = element

    const rect = element.getBoundingClientRect()
    const tooltip = this.elementSelector.tooltip!
    const selector = this.generateSelector(element)
    tooltip.textContent = `选择器: ${selector}\n标签: ${element.tagName.toLowerCase()}\n类名: ${(element as HTMLElement).className || '无'}`
    tooltip.style.left = Math.min(e.clientX + 15, window.innerWidth - 320) + 'px'
    tooltip.style.top = Math.max(e.clientY - 60, 10) + 'px'

    // 更新高亮框位置和大小
    if (this.highlightOverlay && this.elementSelector?.currentElement) {
      const rect = this.elementSelector.currentElement.getBoundingClientRect()
      this.highlightOverlay.style.top = `${rect.top - 3}px`
      this.highlightOverlay.style.left = `${rect.left - 3}px`
      this.highlightOverlay.style.width = `${rect.width + 6}px`
      this.highlightOverlay.style.height = `${rect.height + 6}px`
      this.highlightOverlay.style.display = 'block'
    }
  }

  private handleElementSelectorClick(e: MouseEvent) {
    if (!this.elementSelector?.isActive || this.elementSelector.isPaused) return

    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation() // 阻止事件冒泡

    const element = this.elementSelector.currentElement
    if (!element) return

    const selector = this.generateSelector(element)

    // 暂停选择器模式
    this.elementSelector.isPaused = true
    this.elementSelector.tooltip!.style.display = 'none'
    document.removeEventListener('mousemove', this.elementSelector.mouseMoveHandler!)
    document.removeEventListener('keydown', this.elementSelector.keyHandler!)

    this.showSelectorTypePopup(element, selector)
  }

  private showSelectorTypePopup(element: Element, selector: string) {
    const popup = document.createElement('div')
    popup.className = 'selector-type-popup'
    popup.style.zIndex = '9999999999' // 保证最高
    popup.innerHTML = `
      <h3>选择选择器类型</h3>
      <div class="selector-type-buttons">
        <button class="selector-type-btn" data-type="video">视频选择器</button>
        <button class="selector-type-btn" data-type="title">标题选择器</button>
        <button class="selector-type-btn" data-type="author">作者选择器</button>
        <button class="selector-type-btn" data-type="container">容器选择器</button>
      </div>
      <div class="selector-info">
        <div class="selector-info-line">选择器: <span class="selected-selector-text">${selector}</span></div>
        <div class="selector-info-line">标签: ${element.tagName.toLowerCase()}</div>
        <div class="copy-tip"><button class="copy-selector-btn">复制选择器</button></div>
        <div class="esc-tip">按 ESC 键取消选择</div>
      </div>
    `

    popup.querySelectorAll('.selector-type-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation()
        const type = btn.getAttribute('data-type')

        if (!type) {
          logger.error('选择器类型为空')
          return
        }

        // 保存选择器到配置
        const saved = await this.saveSelectorToConfig(selector, type, element)

        popup.remove()
        this.stopElementSelector() // 完全停止选择器

        if (saved) {
          this.showSelectorMessage(
            `${type}选择器已保存: ${selector}\n\n配置已自动更新，可在设置页面查看。`,
          )
        }
      })
    })

    const copyBtn = popup.querySelector('.copy-selector-btn')
    if (copyBtn) {
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        navigator.clipboard
          .writeText(selector)
          .then(() => {
            copyBtn.textContent = '已复制!'
            setTimeout(() => {
              copyBtn.textContent = '复制选择器'
            }, 1500)
          })
          .catch((err) => {
            logger.error('复制失败:', err)
            alert('复制失败，请手动复制。')
          })
      })
    }

    const handlePopupKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        popup.remove()
        document.removeEventListener('keydown', handlePopupKeydown)
        this.stopElementSelector()
        this.showSelectorMessage('已取消保存选择器。')
      }
    }

    // 隐藏高亮框和 overlay
    if (this.highlightOverlay) this.highlightOverlay.style.display = 'none'
    if (this.elementSelector?.tooltip) this.elementSelector.tooltip.style.display = 'none'
    this.root.appendChild(popup)
    document.addEventListener('keydown', handlePopupKeydown)
  }

  private handleElementSelectorKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && this.elementSelector?.isActive && !this.elementSelector.isPaused) {
      this.stopElementSelector()
      this.showSelectorMessage('元素选择已取消。')
    }
  }

  private generateSelector(element: Element): string {
    if (element.id) {
      return `#${element.id}`
    }

    let selector = element.tagName.toLowerCase()

    if ((element as HTMLElement).className) {
      const classes = (element as HTMLElement).className
        .split(' ')
        .filter((c) => c.trim())
        .slice(0, 3)
      if (classes.length > 0) {
        selector += '.' + classes.join('.')
      }
    }

    const parent = element.parentElement
    if (parent && document.querySelectorAll(selector).length > 1) {
      const parentSelector = this.generateSelector(parent)
      selector = `${parentSelector} > ${selector}`
    }

    return selector
  }

  private stopElementSelector() {
    if (!this.elementSelector) return

    this.elementSelector.isActive = false
    this.elementSelector.isPaused = false

    if (this.elementSelector.mouseMoveHandler) {
      document.removeEventListener('mousemove', this.elementSelector.mouseMoveHandler)
    }
    if (this.elementSelector.clickHandler) {
      document.removeEventListener('click', this.elementSelector.clickHandler, true)
    }
    if (this.elementSelector.keyHandler) {
      document.removeEventListener('keydown', this.elementSelector.keyHandler)
    }

    if (this.elementSelector.tooltip) {
      this.elementSelector.tooltip.remove()
    }

    const style = document.getElementById('element-selector-style')
    if (style) {
      style.remove()
    }

    // 移除可能存在的类型选择弹窗
    const popup = document.querySelector('.selector-type-popup')
    if (popup) {
      popup.remove()
    }

    this.elementSelector = null

    // 关闭时移除 highlight-overlay
    if (this.highlightOverlay && this.highlightOverlay.parentNode) {
      this.highlightOverlay.parentNode.removeChild(this.highlightOverlay)
      this.highlightOverlay = null
    }
  }

  private showSelectorMessage(message: string) {
    const isDark = this.root.classList.contains('dark')
    const messageDiv = document.createElement('div')
    messageDiv.className = 'zhd-selector-message'
    messageDiv.style.cssText = `
      position: fixed !important;
      top: 24px !important;
      left: 50% !important;
      transform: translateX(-50%) !important;
      background: ${isDark ? 'rgba(15, 15, 35, 0.95)' : 'rgba(255, 255, 255, 0.95)'} !important;
      color: ${isDark ? '#e2e8f0' : '#1e293b'} !important;
      padding: 16px 24px !important;
      border-radius: 16px !important;
      font-size: 14px !important;
      font-weight: 500 !important;
      z-index: 2147483647 !important;
      box-shadow: ${isDark ? '0 10px 25px -5px rgba(0, 0, 0, 0.3), 0 0 20px rgba(59, 130, 246, 0.3)' : '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 0 20px rgba(59, 130, 246, 0.2)'} !important;
      backdrop-filter: blur(20px) saturate(180%) !important;
      border: 1px solid ${isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(148, 163, 184, 0.3)'} !important;
      white-space: pre-line !important;
      text-align: center !important;
      line-height: 1.5 !important;
      font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
      animation: slideInFromTop 0.4s cubic-bezier(0.4, 0, 0.2, 1) !important;
      max-width: 400px !important;
    `
    messageDiv.textContent = message

    document.body.appendChild(messageDiv)

    setTimeout(() => {
      messageDiv.style.animation = 'slideOutToTop 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards'
      setTimeout(() => messageDiv.remove(), 300)
    }, 4000)
  }

  public highlightElement(selector: string) {
    this.removeHighlight()

    const elements = document.querySelectorAll(selector)
    if (elements.length === 0) {
      this.showSelectorMessage(`未找到匹配选择器 "${selector}" 的元素。`)
      return
    }

    this.highlightOverlay = document.createElement('div')
    this.highlightOverlay.className = 'highlight-overlay'
    document.body.appendChild(this.highlightOverlay)

    const updateHighlight = () => {
      if (!this.highlightOverlay) return

      let minX = Number.POSITIVE_INFINITY,
        minY = Number.POSITIVE_INFINITY,
        maxX = Number.NEGATIVE_INFINITY,
        maxY = Number.NEGATIVE_INFINITY
      let foundVisible = false

      elements.forEach((el) => {
        const rect = el.getBoundingClientRect()
        if (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth
        ) {
          minX = Math.min(minX, rect.left + window.scrollX)
          minY = Math.min(minY, rect.top + window.scrollY)
          maxX = Math.max(maxX, rect.right + window.scrollX)
          maxY = Math.max(maxY, rect.bottom + window.scrollY)
          foundVisible = true
        }
      })

      if (foundVisible) {
        this.highlightOverlay.style.left = `${minX}px`
        this.highlightOverlay.style.top = `${minY}px`
        this.highlightOverlay.style.width = `${maxX - minX}px`
        this.highlightOverlay.style.height = `${maxY - minY}px`
        this.highlightOverlay.style.display = 'block'
      } else {
        this.highlightOverlay.style.display = 'none'
      }
    }

    updateHighlight()
    window.addEventListener('scroll', updateHighlight)
    window.addEventListener('resize', updateHighlight)

    this.highlightTimeout = setTimeout(() => {
      this.removeHighlight()
      window.removeEventListener('scroll', updateHighlight)
      window.removeEventListener('resize', updateHighlight)
    }, 3000)
    this.showSelectorMessage(`已高亮匹配选择器 "${selector}" 的元素。`)
  }

  private removeHighlight() {
    if (this.highlightOverlay) {
      this.highlightOverlay.remove()
      this.highlightOverlay = null
    }
    if (this.highlightTimeout) {
      clearTimeout(this.highlightTimeout)
      this.highlightTimeout = null
    }
  }

  public destroy() {
    if (this.observer) {
      this.observer.disconnect()
      this.observer = null
    }
    if (this.elementSelector) {
      this.stopElementSelector()
    }
    this.removeHighlight()

    this.videoEventListeners = new WeakMap()

    this.downloadButtons.forEach((button) => {
      if (button.parentNode) {
        button.parentNode.removeChild(button)
      }
    })
    this.downloadButtons.clear()
    this.processedVideos = new WeakSet()
    this.updateBadgeCount(0)
  }
}

// 启动通用下载器
const downloaderInstance = new UniversalVideoDownloader()
  ; (window as any).universalVideoDownloaderInstance = downloaderInstance

// 页面卸载时清理
window.addEventListener('beforeunload', () => {
  if ((window as any).universalVideoDownloaderInstance) {
    ; (window as any).universalVideoDownloaderInstance.destroy()
    delete (window as any).universalVideoDownloaderInstance
  }
})

// 监听页面变化（SPA应用）
let currentUrl = location.href
new MutationObserver(() => {
  if (location.href !== currentUrl) {
    currentUrl = location.href
    if ((window as any).universalVideoDownloaderInstance) {
      ; (window as any).universalVideoDownloaderInstance.destroy()
      setTimeout(() => {
        ; (window as any).universalVideoDownloaderInstance = new UniversalVideoDownloader()
      }, 1000)
    }
  }
}).observe(document, { subtree: true, childList: true })
