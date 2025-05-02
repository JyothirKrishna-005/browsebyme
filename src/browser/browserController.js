/**
 * Browser Controller - Manages browser instances and provides automation methods
 */
const { chromium, firefox, webkit } = require('playwright');
const { logger } = require('../utils/logger');
const config = require('../config/config');

class BrowserController {
  constructor() {
    this.browsers = new Map(); // Map to store active browser instances
    this.defaultBrowser = config.browser.defaultType || 'chromium';
    this.defaultTimeout = config.browser.defaultTimeout || 30000;
    this.elementCache = new Map(); // Cache for recently accessed elements
  }

  /**
   * Launch a new browser instance
   * @param {string} browserType - Type of browser (chromium, firefox, webkit)
   * @param {object} options - Browser launch options
   * @returns {object} Browser session information
   */
  async launchBrowser(browserType = this.defaultBrowser, options = {}) {
    try {
      const sessionId = `${browserType}-${Date.now()}`;
      
      // Select browser based on type
      let browser;
      switch (browserType.toLowerCase()) {
        case 'firefox':
          browser = await firefox.launch({ headless: false, ...options });
          break;
        case 'webkit':
        case 'safari':
          browser = await webkit.launch({ headless: false, ...options });
          break;
        case 'chromium':
        case 'chrome':
        case 'edge':
        default:
          browser = await chromium.launch({ headless: false, ...options });
      }
      
      // Create a context with more realistic viewport
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        acceptDownloads: true,
        // Add permissions for notifications, etc.
        permissions: ['notifications', 'geolocation']
      });
      
      // Set default timeout
      context.setDefaultTimeout(this.defaultTimeout);
      
      const page = await context.newPage();
      
      // Handle dialogs automatically
      page.on('dialog', async dialog => {
        logger.info(`Auto-accepting dialog: ${dialog.message()}`);
        await dialog.accept();
      });
      
      // Store browser session
      this.browsers.set(sessionId, { 
        browser, 
        context, 
        page, 
        type: browserType,
        createdAt: new Date()
      });
      
      logger.info(`Browser launched: ${browserType} (${sessionId})`);
      
      return {
        sessionId,
        type: browserType
      };
    } catch (error) {
      logger.error(`Failed to launch browser: ${error.message}`);
      throw new Error(`Failed to launch browser: ${error.message}`);
    }
  }

  /**
   * Navigate to a URL
   * @param {string} url - URL to navigate to
   * @param {string} sessionId - Browser session ID
   * @returns {object} Navigation result
   */
  async navigateTo(url, sessionId) {
    try {
      const session = this.getSession(sessionId);
      
      // Make sure URL has protocol
      if (!url.startsWith('http')) {
        url = 'https://' + url;
      }
      
      logger.info(`Navigating to: ${url} (${sessionId})`);
      
      // Use a more reliable navigation strategy instead of waiting for networkidle
      // First navigate with domcontentloaded which is more reliable
      const response = await session.page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: this.defaultTimeout 
      });
      
      // After basic navigation completes, we'll wait for the page to stabilize
      // But we won't make it part of the navigation promise to avoid timeouts
      try {
        // Wait for common page elements to indicate the page is usable
        await Promise.race([
          session.page.waitForSelector('body', { timeout: 5000 }),
          session.page.waitForLoadState('load', { timeout: 10000 }).catch(() => {})
        ]);
      } catch (e) {
        // Don't throw if this fails - page might still be usable
        logger.warn(`Page stabilization timed out for ${url}, but continuing anyway`);
      }
      
      // Wait a moment for any initial scripts to run
      await session.page.waitForTimeout(500);
      
      logger.info(`Navigated to: ${url} (${sessionId})`);
      
      // If navigation failed with an error response, log it but don't fail
      if (response && response.status() >= 400) {
        logger.warn(`Page loaded with status ${response.status()} for ${url}`);
      }
      
      // Clear element cache after navigation
      this.elementCache.clear();
      
      return {
        url: response ? response.url() : url,
        status: response ? response.status() : 0,
        title: await session.page.title()
      };
    } catch (error) {
      logger.error(`Navigation error: ${error.message}`);
      throw new Error(`Failed to navigate to ${url}: ${error.message}`);
    }
  }

  /**
   * Fill a form field
   * @param {string} selector - Element selector
   * @param {string} value - Value to enter
   * @param {string} sessionId - Browser session ID
   */
  async fillField(selector, value, sessionId) {
    try {
      const session = this.getSession(sessionId);
      
      // Try to find element with specific selectors first
      const resolvedSelector = await this.findBestSelector(selector, sessionId);
      if (!resolvedSelector) {
        throw new Error(`Could not find element matching: ${selector}`);
      }
      
      // Wait for the element to be visible before interacting
      await session.page.waitForSelector(resolvedSelector, { state: 'visible', timeout: this.defaultTimeout });
      
      // Clear the field first (if it's not empty)
      await session.page.evaluate((sel) => {
        const element = document.querySelector(sel);
        if (element) element.value = '';
      }, resolvedSelector);
      
      // Fill the field
      await session.page.fill(resolvedSelector, value);
      
      // Trigger change event to ensure JavaScript detects the change
      await session.page.evaluate((sel) => {
        const element = document.querySelector(sel);
        if (element) {
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, resolvedSelector);
      
      logger.info(`Filled field: ${resolvedSelector} (${sessionId})`);
      return { success: true, selector: resolvedSelector };
    } catch (error) {
      logger.error(`Fill field error: ${error.message}`);
      throw new Error(`Failed to fill field ${selector}: ${error.message}`);
    }
  }

  /**
   * Click on an element
   * @param {string} selector - Element selector
   * @param {string} sessionId - Browser session ID
   */
  async clickElement(selector, sessionId) {
    try {
      const session = this.getSession(sessionId);
      
      // Try to find element with the best match first
      const resolvedSelector = await this.findBestSelector(selector, sessionId);
      
      if (!resolvedSelector) {
        // If we can't find a direct match, try special handling for product listings
        const isProductSelector = this.isProductListingSelector(selector);
        
        if (isProductSelector) {
          const result = await this.handleProductListingClick(selector, sessionId);
          if (result.success) {
            return result;
          }
        }
        
        throw new Error(`Element ${selector} not found or not visible`);
      }
      
      // Wait for the element to be enabled/clickable
      await session.page.waitForSelector(resolvedSelector, { 
        state: 'visible', 
        timeout: this.defaultTimeout 
      });
      
      // Scroll element into view
      await session.page.evaluate((sel) => {
        const element = document.querySelector(sel);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, resolvedSelector);
      
      // Wait a brief moment for any animations to complete
      await session.page.waitForTimeout(500);
      
      // Try standard click first
      try {
        await session.page.click(resolvedSelector);
      } catch (clickError) {
        // If standard click fails, try alternative approaches
        logger.warn(`Standard click failed for ${resolvedSelector}, trying alternatives: ${clickError.message}`);
        
        await this.attemptAlternativeClicks(resolvedSelector, sessionId);
      }
      
      // Wait a moment for any page changes to start
      await session.page.waitForTimeout(500);
      
      logger.info(`Clicked element: ${resolvedSelector} (${sessionId})`);
      return { success: true, selector: resolvedSelector };
    } catch (error) {
      logger.error(`Click element error: ${error.message}`);
      throw new Error(`Failed to click element ${selector}: ${error.message}`);
    }
  }
  
  /**
   * Check if a selector appears to be targeting a product in a listing
   * @param {string} selector - Element selector to check
   * @returns {boolean} True if it's likely a product listing selector
   */
  isProductListingSelector(selector) {
    // Common patterns for product listings
    const productPatterns = [
      /nth-of-type/i,
      /nth-child/i,
      /s-result-item/i,
      /product-item/i,
      /product-card/i,
      /product\s+\d+/i,
      /item\s+\d+/i,
      /result\s+\d+/i,
      /search-result/i
    ];
    
    return productPatterns.some(pattern => pattern.test(selector));
  }
  
  /**
   * Attempt alternative click approaches when standard click fails
   * @param {string} selector - Element selector
   * @param {string} sessionId - Browser session ID
   */
  async attemptAlternativeClicks(selector, sessionId) {
    const session = this.getSession(sessionId);
    
    // Try 3 different click strategies
    const attempts = [
      // 1. Try JavaScript click
      async () => {
        return await session.page.evaluate((sel) => {
          const element = document.querySelector(sel);
          if (element) {
            element.click();
            return true;
          }
          return false;
        }, selector);
      },
      
      // 2. Try click via mouse position
      async () => {
        const elementHandle = await session.page.$(selector);
        if (elementHandle) {
          const boundingBox = await elementHandle.boundingBox();
          if (boundingBox) {
            await session.page.mouse.click(
              boundingBox.x + boundingBox.width / 2,
              boundingBox.y + boundingBox.height / 2
            );
            return true;
          }
        }
        return false;
      },
      
      // 3. Try parent element click
      async () => {
        return await session.page.evaluate((sel) => {
          const element = document.querySelector(sel);
          if (element && element.parentElement) {
            element.parentElement.click();
            return true;
          }
          return false;
        }, selector);
      }
    ];
    
    // Try each approach
    for (const attempt of attempts) {
      try {
        const success = await attempt();
        if (success) {
          logger.info(`Alternative click succeeded for ${selector}`);
          return true;
        }
      } catch (e) {
        // Continue to next attempt
        continue;
      }
    }
    
    throw new Error(`All click attempts failed for ${selector}`);
  }
  
  /**
   * Handle clicks in product listings which often have complex structures
   * @param {string} selector - Original selector (often nth-child based)
   * @param {string} sessionId - Browser session ID
   * @returns {object} Click result
   */
  async handleProductListingClick(selector, sessionId) {
    const session = this.getSession(sessionId);
    
    try {
      // First, examine the selector to understand what it's trying to target
      const parts = selector.split(/\s+/);
      
      // Get the index if this is an nth-child or nth-of-type selector
      let targetIndex = 0;
      const indexMatch = selector.match(/nth-(?:child|of-type)\((\d+)\)/i);
      if (indexMatch) {
        targetIndex = parseInt(indexMatch[1], 10) - 1; // Convert to 0-based index
      }
      
      // Extract likely container pattern and target element type
      let containerPattern = '';
      let targetElement = 'a';
      
      if (selector.includes('result-item') || selector.includes('s-result')) {
        containerPattern = '.s-result-item, [data-component-type="s-search-result"]';
      } else if (selector.includes('product-item') || selector.includes('product-card')) {
        containerPattern = '.product-item, .product-card, [data-testid="product-card"]';
      } else {
        // Generic list item pattern
        containerPattern = '.item, .product, li[class*="item"], li[class*="product"], div[class*="product"]';
      }
      
      // If the selector mentions "h2 a", we're likely looking for a product title link
      if (selector.includes('h2') && selector.includes('a')) {
        targetElement = 'h2 a, .product-title a, .title a, a[class*="title"], a.item-title';
      } else if (selector.includes('img')) {
        targetElement = 'img, .product-image img, .item-image img, a img';
      }
      
      // Now use a robust approach - get all matching containers first
      const productElements = await session.page.$$(containerPattern);
      
      if (productElements.length === 0) {
        logger.warn(`No product containers found matching ${containerPattern}`);
        return { success: false };
      }
      
      // Use the target index, or default to the first item
      const targetProductIndex = Math.min(targetIndex, productElements.length - 1);
      const targetProduct = productElements[targetProductIndex];
      
      // Try multiple approaches to find clickable element within the target product
      // 1. First try to find the specific target element within this product
      const nestedTarget = await targetProduct.$(targetElement);
      
      if (nestedTarget) {
        // Found target - scroll it into view
        await session.page.evaluate((element) => {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, nestedTarget);
        
        await session.page.waitForTimeout(500);
        
        // Try to click it
        await nestedTarget.click();
        logger.info(`Successfully clicked nested target in product listing`);
        return { success: true };
      }
      
      // 2. If specific target not found, click the product element itself
      await session.page.evaluate((element) => {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, targetProduct);
      
      await session.page.waitForTimeout(500);
      
      // Find the most clickable element within the product
      const clicked = await session.page.evaluate((productElement) => {
        // Priority list of elements to try clicking
        const clickPriority = [
          'a[href]:visible',  // Any visible link
          'a.product-title, a.item-title, h2 a, .product-name a', // Title links
          'img[class*="product"], img[class*="item"]', // Product images
          'a:has(img)', // Links with images
          'a', // Any link
          '[onclick]', // Elements with click handlers
          '[role="button"]', // Buttons
          '[class*="button"]' // Button-like elements
        ];
        
        let elementToClick = null;
        
        for (const selector of clickPriority) {
          const elements = productElement.querySelectorAll(selector);
          if (elements.length > 0) {
            elementToClick = elements[0];
            break;
          }
        }
        
        // If we found an element, click it
        if (elementToClick) {
          elementToClick.click();
          return true;
        }
        
        // Last resort - click the product element itself
        productElement.click();
        return true;
      }, targetProduct);
      
      if (clicked) {
        logger.info(`Successfully clicked product element using enhanced product listing handler`);
        return { success: true };
      }
      
      return { success: false };
    } catch (error) {
      logger.error(`Product listing click handler error: ${error.message}`);
      return { success: false };
    }
  }

  /**
   * Find the best selector for an element
   * @param {string} selector - Initial selector or description
   * @param {string} sessionId - Browser session ID  
   * @returns {string|null} Best matching selector or null if not found
   */
  async findBestSelector(selector, sessionId) {
    const session = this.getSession(sessionId);
    
    // Handle nth-child selectors specially
    if (selector.includes('nth-child') || selector.includes('nth-of-type')) {
      try {
        const elements = await session.page.$$(selector);
        if (elements.length > 0) {
          const isVisible = await elements[0].isVisible();
          if (isVisible) return selector;
        }
      } catch (e) {
        // Try alternative selector strategies for positional selectors
        const alternativeSelector = this.convertNthSelector(selector);
        if (alternativeSelector && alternativeSelector !== selector) {
          try {
            const elements = await session.page.$$(alternativeSelector);
            if (elements.length > 0) {
              const isVisible = await elements[0].isVisible();
              if (isVisible) return alternativeSelector;
            }
          } catch (altError) {
            // Continue with other approaches
          }
        }
      }
    }
    
    // Step 1: Check if selector is directly valid
    try {
      const isVisible = await this.isElementVisible(selector, sessionId);
      if (isVisible) return selector;
    } catch (e) {
      // Ignore error, continue to alternatives
    }
    
    // Step 2: Check cached selectors (if we have text description)
    if (!selector.includes('.') && !selector.includes('#') && !selector.includes('[')) {
      for (const [cachedSelector, info] of this.elementCache.entries()) {
        if (info.text && info.text.toLowerCase().includes(selector.toLowerCase())) {
          const isVisible = await this.isElementVisible(cachedSelector, sessionId);
          if (isVisible) return cachedSelector;
        }
      }
    }
    
    // Step 3: Try various alternative selectors
    const alternatives = this.generateAlternativeSelectors(selector);
    for (const alt of alternatives) {
      try {
        const isVisible = await this.isElementVisible(alt, sessionId);
        if (isVisible) return alt;
      } catch (e) {
        // Continue to next alternative
        continue;
      }
    }
    
    // Step 4: Use text-based search for interactive elements
    if (!selector.includes('.') && !selector.includes('#') && !selector.includes('[')) {
      // Use standard Playwright text selectors
      const textSelectors = [
        `text=${selector}`,           // Exact text match
        `text="${selector}"`,         // Quoted text match
        `[placeholder="${selector}"]` // Placeholder attribute
      ];
      
      for (const textSelector of textSelectors) {
        try {
          const elements = await session.page.$$(textSelector);
          if (elements.length > 0) {
            const isVisible = await elements[0].isVisible();
            if (isVisible) return textSelector;
          }
        } catch (e) {
          // Ignore error, try next selector
        }
      }
    }
    
    // Step 5: Check if it's a product listing selector and handle specially
    if (this.isProductListingSelector(selector)) {
      // Try to find any visible product items
      const productSelectors = [
        '.s-result-item', 
        '[data-component-type="s-search-result"]',
        '.product-item', 
        '.product-card', 
        '[data-testid="product-card"]',
        '.item',
        'li[class*="product"]',
        'div[class*="product"]'
      ];
      
      for (const prodSel of productSelectors) {
        try {
          const elements = await session.page.$$(prodSel);
          if (elements.length > 0) {
            const isVisible = await elements[0].isVisible();
            if (isVisible) {
              // Extract index information from the original selector
              const indexMatch = selector.match(/nth-(?:child|of-type)\((\d+)\)/i);
              if (indexMatch) {
                const index = parseInt(indexMatch[1], 10);
                return `${prodSel}:nth-child(${index})`;
              } else {
                return `${prodSel}:first-child`;
              }
            }
          }
        } catch (e) {
          // Try next product selector
          continue;
        }
      }
    }
    
    // Step 6: Try to find by analyzing the page structure
    try {
      const analysisResult = await this.analyzePageStructure(selector, sessionId);
      if (analysisResult) return analysisResult;
    } catch (e) {
      logger.warn(`Page structure analysis failed: ${e.message}`);
    }
    
    // No suitable selector found
    return null;
  }
  
  /**
   * Convert nth-child or nth-of-type selectors to alternative formats
   * @param {string} selector - Original selector with nth-child or nth-of-type
   * @returns {string} Alternative selector format
   */
  convertNthSelector(selector) {
    // Extract the index
    const nthMatch = selector.match(/nth-(?:child|of-type)\((\d+)\)/i);
    if (!nthMatch) return selector;
    
    const index = parseInt(nthMatch[1], 10);
    
    // Split the selector to get the container and the target
    const parts = selector.split(/\s+/);
    
    // If it's a simple nth-child on a single element
    if (parts.length === 1) {
      // Try with :eq() as alternative
      return selector.replace(/nth-(?:child|of-type)\((\d+)\)/i, `:nth-child(${index})`);
    }
    
    // If we have a more complex selector like ".container .item:nth-child(2) a"
    const nthPartIndex = parts.findIndex(part => part.includes('nth-'));
    
    if (nthPartIndex >= 0 && nthPartIndex < parts.length - 1) {
      // We have elements after the nth-part, try to construct alternative
      const containerParts = parts.slice(0, nthPartIndex + 1);
      const targetParts = parts.slice(nthPartIndex + 1);
      
      // Replace the nth-part with a different approach
      const containerSelector = containerParts.join(' ').replace(/nth-(?:child|of-type)\((\d+)\)/i, `:nth-child(${index})`);
      
      // Alternatives to try
      return `${containerSelector} ${targetParts.join(' ')}`;
    }
    
    return selector;
  }

  /**
   * Generate alternative selectors for an element
   * @param {string} originalSelector - Original selector
   * @returns {Array} Array of alternative selectors
   */
  generateAlternativeSelectors(originalSelector) {
    const alternatives = [];
    const lowerSelector = originalSelector.toLowerCase();
    
    // Handle nth-child and nth-of-type selectors
    if (lowerSelector.includes('nth-child') || lowerSelector.includes('nth-of-type')) {
      const nthMatch = originalSelector.match(/nth-(?:child|of-type)\((\d+)\)/i);
      if (nthMatch) {
        const index = parseInt(nthMatch[1], 10);
        
        // Add variations of the nth-selector
        const baseWithoutNth = originalSelector.replace(/\:nth-(?:child|of-type)\((\d+)\)/i, '');
        alternatives.push(`${baseWithoutNth}:nth-child(${index})`);
        alternatives.push(`${baseWithoutNth}:nth-of-type(${index})`);
        
        // For first item, add :first-child alternatives
        if (index === 1) {
          alternatives.push(`${baseWithoutNth}:first-child`);
          alternatives.push(`${baseWithoutNth}:first-of-type`);
        }
        
        // Product listing specific alternatives
        if (originalSelector.includes('result-item') || originalSelector.includes('product')) {
          const nthReplaced = originalSelector.replace(/\:nth-(?:child|of-type)\((\d+)\)/i, '');
          alternatives.push(`${nthReplaced}:nth-child(${index})`);
          alternatives.push(`.s-result-item:nth-child(${index})`);
          alternatives.push(`[data-component-type="s-search-result"]:nth-child(${index})`);
          alternatives.push(`.product-item:nth-child(${index})`);
          alternatives.push(`.product-card:nth-child(${index})`);
          alternatives.push(`[data-testid="product-card"]:nth-child(${index})`);
        }
      }
    }
    
    // Add site-specific selectors for common elements
    // Amazon.in specific selectors
    if (lowerSelector.includes('search') || lowerSelector.includes('find')) {
      alternatives.push('#twotabsearchtextbox'); // Amazon search box
      alternatives.push('input[name="field-keywords"]');
      alternatives.push('input[aria-label*="search" i]');
    }
    
    // Amazon search submit button
    if (lowerSelector.includes('search button') || lowerSelector.includes('submit search')) {
      alternatives.push('input[value="Go"]');
      alternatives.push('input.nav-input[type="submit"]');
      alternatives.push('#nav-search-submit-button');
    }
    
    // If it's a button selector, try common button patterns
    if (lowerSelector.includes('button')) {
      alternatives.push('button');
      alternatives.push('[type="button"]');
      alternatives.push('[role="button"]');
      alternatives.push('.btn');
      alternatives.push('.button');
      alternatives.push('input[type="button"]');
      alternatives.push('input[type="submit"]');
      
      // If the selector has text after "button", use it for text matching
      const buttonTextMatch = lowerSelector.match(/button\s+(.+)/i);
      if (buttonTextMatch) {
        const text = buttonTextMatch[1].trim();
        alternatives.push(`button:has-text("${text}")`);
        alternatives.push(`[role="button"]:has-text("${text}")`);
        alternatives.push(`button:text-is("${text}")`);
      }
    }
    
    // If it's a link selector, try common link patterns
    if (lowerSelector.includes('link') || lowerSelector.includes('a ')) {
      alternatives.push('a');
      alternatives.push('[href]');
      
      // If the selector has text after "link", use it for text matching
      const linkTextMatch = lowerSelector.match(/link\s+(.+)/i) || lowerSelector.match(/a\s+(.+)/i);
      if (linkTextMatch) {
        const text = linkTextMatch[1].trim();
        alternatives.push(`a:has-text("${text}")`);
        alternatives.push(`a:text-is("${text}")`);
      }
    }
    
    // If it's a form field, try common field patterns
    if (lowerSelector.includes('input') || lowerSelector.includes('field') || lowerSelector.includes('text') || lowerSelector.includes('box')) {
      alternatives.push('input');
      alternatives.push('textarea');
      alternatives.push('input[type="text"]');
      
      // More specific fields by common names
      if (lowerSelector.includes('email')) {
        alternatives.push('input[type="email"]');
        alternatives.push('input[name*="email" i]');
        alternatives.push('input[placeholder*="email" i]');
      } else if (lowerSelector.includes('password')) {
        alternatives.push('input[type="password"]');
        alternatives.push('input[name*="password" i]');
        alternatives.push('input[placeholder*="password" i]');
      } else if (lowerSelector.includes('phone')) {
        alternatives.push('input[type="tel"]');
        alternatives.push('input[name*="phone" i]');
        alternatives.push('input[placeholder*="phone" i]');
      }
    }
    
    // If it's a search field
    if (lowerSelector.includes('search') || lowerSelector.includes('[name="q"]') || lowerSelector.includes('find')) {
      alternatives.push('input[type="search"]');
      alternatives.push('input[name="q"]');
      alternatives.push('input[placeholder*="search" i]');
      alternatives.push('[aria-label*="search" i]');
      alternatives.push('[name="field-keywords"]'); // Amazon specific
      alternatives.push('#twotabsearchtextbox'); // Amazon specific
    }
    
    // Submit buttons
    if (lowerSelector.includes('submit') || lowerSelector.includes('send') || lowerSelector.includes('go')) {
      alternatives.push('[type="submit"]');
      alternatives.push('button[type="submit"]');
      alternatives.push('input[type="submit"]');
      alternatives.push('button:has-text("Search")');
      alternatives.push('button:has-text("Submit")');
      alternatives.push('button:has-text("Go")');
      alternatives.push('button:has-text("Send")');
      alternatives.push('input[value="Go"]');
      alternatives.push('#nav-search-submit-button'); // Amazon specific
    }
    
    // Product links
    if (lowerSelector.includes('product') || lowerSelector.includes('item') || lowerSelector.includes('result')) {
      alternatives.push('.s-result-item h2 a');
      alternatives.push('[data-component-type="s-search-result"] h2 a');
      alternatives.push('.product-item a.product-title');
      alternatives.push('.product-card a.title');
      alternatives.push('[data-testid="product-card"] a[data-testid="title"]');
    }
    
    return alternatives;
  }

  /**
   * Analyze page structure to find a specific element
   * @param {string} selector - Element description or partial selector
   * @param {string} sessionId - Browser session ID
   * @returns {string|null} Generated selector or null if not found
   */
  async analyzePageStructure(description, sessionId) {
    const session = this.getSession(sessionId);
    
    // Use JavaScript in the page context to analyze the DOM
    const analysisResult = await session.page.evaluate((desc) => {
      // Helper function to check if element is visible
      function isVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetWidth > 0 && el.offsetHeight > 0;
      }
      
      // Get all interactive visible elements
      const allElements = Array.from(document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"]'));
      const visibleElements = allElements.filter(el => isVisible(el));
      
      // Search for elements by text content or attributes
      const lowerDesc = desc.toLowerCase();
      const matchingElements = visibleElements.filter(el => {
        const text = el.textContent?.trim().toLowerCase() || '';
        const ariaLabel = el.getAttribute('aria-label')?.toLowerCase() || '';
        const placeholder = el.getAttribute('placeholder')?.toLowerCase() || '';
        const title = el.getAttribute('title')?.toLowerCase() || '';
        const alt = el.getAttribute('alt')?.toLowerCase() || '';
        const name = el.getAttribute('name')?.toLowerCase() || '';
        const id = el.getAttribute('id')?.toLowerCase() || '';
        const type = el.getAttribute('type')?.toLowerCase() || '';
        
        return text.includes(lowerDesc) || 
               ariaLabel.includes(lowerDesc) || 
               placeholder.includes(lowerDesc) || 
               title.includes(lowerDesc) || 
               alt.includes(lowerDesc) ||
               name.includes(lowerDesc) ||
               id.includes(lowerDesc) ||
               (type === lowerDesc);
      });
      
      // Return best match if found
      if (matchingElements.length > 0) {
        const bestMatch = matchingElements[0];
        
        // Try to get a precise selector for this element
        // First try with ID if available
        if (bestMatch.id) return `#${bestMatch.id}`;
        
        // Next try with a unique attribute if available
        if (bestMatch.getAttribute('name')) 
          return `[name="${bestMatch.getAttribute('name')}"]`;
        
        if (bestMatch.getAttribute('aria-label')) 
          return `[aria-label="${bestMatch.getAttribute('aria-label')}"]`;
        
        if (bestMatch.getAttribute('placeholder')) 
          return `[placeholder="${bestMatch.getAttribute('placeholder')}"]`;
        
        if (bestMatch.getAttribute('data-testid')) 
          return `[data-testid="${bestMatch.getAttribute('data-testid')}"]`;
        
        // If nothing specific found, collect tag name, classes and textContent for reconstruction
        return JSON.stringify({
          tag: bestMatch.tagName.toLowerCase(),
          text: bestMatch.textContent?.trim() || '',
          classes: Array.from(bestMatch.classList)
        });
      }
      
      return null;
    }, description);
    
    if (!analysisResult) return null;
    
    // If we got a JSON object instead of a direct selector, reconstruct a selector
    if (analysisResult.startsWith('{')) {
      try {
        const data = JSON.parse(analysisResult);
        let selector = data.tag;
        
        if (data.classes.length > 0) {
          selector += '.' + data.classes.join('.');
        }
        
        if (data.text) {
          // Cache this selector with its text for future use
          this.elementCache.set(selector, { text: data.text });
          
          if (data.tag === 'button' || data.tag === 'a') {
            // For buttons and links, we can use the :text pseudo-class
            selector = `${data.tag}:has-text("${data.text}")`;
          }
        }
        
        return selector;
      } catch (e) {
        logger.error(`Error parsing element data: ${e.message}`);
        return null;
      }
    }
    
    return analysisResult;
  }

  /**
   * Find an element based on description or selector
   * @param {string} description - Element description or selector
   * @param {string} sessionId - Browser session ID
   * @returns {ElementHandle|null} Playwright element handle or null if not found
   */
  async findElement(description, sessionId) {
    try {
      const session = this.getSession(sessionId);
      
      // First try to find the best selector that matches the description
      const selector = await this.findBestSelector(description, sessionId);
      
      if (!selector) {
        logger.warn(`No element found matching description: ${description}`);
        return null;
      }
      
      // Wait for the element to be visible
      await session.page.waitForSelector(selector, { 
        state: 'visible', 
        timeout: 5000 
      });
      
      // Get the element handle
      const elementHandle = await session.page.$(selector);
      
      if (!elementHandle) {
        logger.warn(`Element found with selector ${selector} but couldn't get handle`);
        return null;
      }
      
      // Check if element is visible
      const isVisible = await elementHandle.isVisible();
      if (!isVisible) {
        logger.warn(`Element found with selector ${selector} but is not visible`);
        await elementHandle.dispose();
        return null;
      }
      
      return elementHandle;
    } catch (error) {
      logger.error(`Find element error: ${error.message}`);
      return null;
    }
  }

  /**
   * Check if an element is visible
   * @param {string} selector - Element selector
   * @param {string} sessionId - Browser session ID
   * @returns {boolean} True if element is visible
   */
  async isElementVisible(selector, sessionId) {
    try {
      const session = this.getSession(sessionId);
      
      // Use Playwright's built-in isVisible method
      const element = await session.page.$(selector);
      
      if (!element) return false;
      
      const isVisible = await element.isVisible();
      return isVisible;
    } catch (e) {
      return false;
    }
  }

  /**
   * Get page structure information (DevTools-like inspection)
   * @param {string} sessionId - Browser session ID
   * @returns {object} Page structure information
   */
  async getPageStructure(sessionId) {
    try {
      const session = this.getSession(sessionId);
      
      // Extract interactive elements on the page with their attributes
      const structure = await session.page.evaluate(() => {
        // Helper function to get element attributes
        const getElementInfo = (element) => {
          const rect = element.getBoundingClientRect();
          const computedStyle = window.getComputedStyle(element);
          
          // Get all attributes as an object
          const attributes = {};
          Array.from(element.attributes).forEach(attr => {
            attributes[attr.name] = attr.value;
          });
          
          // Get text content
          const textContent = element.textContent?.trim() || '';
          
          // Get input value if applicable
          let value = '';
          if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT') {
            value = element.value || '';
          }
          
          // Get all ARIA attributes
          const ariaAttributes = {};
          for (const attr in element.attributes) {
            if (attr.startsWith('aria-')) {
              ariaAttributes[attr] = element.getAttribute(attr);
            }
          }
          
          // Get parent info for context
          const parentInfo = element.parentElement ? {
            tag: element.parentElement.tagName.toLowerCase(),
            id: element.parentElement.id || null,
            className: element.parentElement.className || null,
            textContent: element.parentElement.textContent?.trim().substring(0, 50) || null
          } : null;
          
          return {
            tag: element.tagName.toLowerCase(),
            id: element.id || null,
            name: element.getAttribute('name') || null,
            className: element.className || null,
            type: element.getAttribute('type') || null,
            value: value,
            placeholder: element.getAttribute('placeholder') || null,
            ariaLabel: element.getAttribute('aria-label') || null,
            title: element.getAttribute('title') || null,
            alt: element.getAttribute('alt') || null,
            role: element.getAttribute('role') || null,
            textContent: textContent.substring(0, 100), // Limit text length
            innerText: element.innerText?.trim().substring(0, 100) || null,
            isContentEditable: element.isContentEditable,
            attributes: attributes,
            ariaAttributes: ariaAttributes,
            parent: parentInfo,
            visible: !(computedStyle.display === 'none' || computedStyle.visibility === 'hidden' || rect.width === 0 || rect.height === 0),
            position: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              top: rect.top,
              left: rect.left,
              bottom: rect.bottom,
              right: rect.right
            },
            zIndex: parseInt(computedStyle.zIndex) || 0,
            xpath: getXPath(element)
          };
        };
        
        // Function to get XPath for an element
        const getXPath = (element) => {
          if (!element) return '';
          
          let xpath = '';
          let parent = element;
          
          while (parent && parent.nodeType === 1) {
            let index = 1;
            let hasSiblings = false;
            
            for (let sibling = parent.previousSibling; sibling; sibling = sibling.previousSibling) {
              if (sibling.nodeType === 1 && sibling.tagName === parent.tagName) {
                index++;
                hasSiblings = true;
              }
            }
            
            const tagName = parent.tagName.toLowerCase();
            const pathIndex = hasSiblings ? `[${index}]` : '';
            xpath = `/${tagName}${pathIndex}${xpath}`;
            
            parent = parent.parentNode;
          }
          
          return xpath;
        };
        
        // Get ALL elements (not just interactive ones)
        const allElements = document.querySelectorAll('*');
        const elementData = Array.from(allElements).map(getElementInfo);
        
        // Get focused element
        const focusedElement = document.activeElement ? getElementInfo(document.activeElement) : null;
        
        // Get all forms and their fields for better form understanding
        const forms = Array.from(document.forms).map(form => {
          return {
            id: form.id || null,
            name: form.name || null,
            action: form.action || null,
            method: form.method || null,
            fields: Array.from(form.elements).map(field => {
              return {
                type: field.type || null,
                name: field.name || null,
                id: field.id || null,
                value: field.value || null,
                placeholder: field.placeholder || null,
                required: field.required || false,
                disabled: field.disabled || false
              };
            })
          };
        });
        
        // Get canvas elements for drawing operations
        const canvasElements = Array.from(document.querySelectorAll('canvas')).map(canvas => {
          return {
            id: canvas.id || null,
            width: canvas.width,
            height: canvas.height,
            position: canvas.getBoundingClientRect()
          };
        });
        
        return {
          title: document.title,
          url: window.location.href,
          focusedElement: focusedElement,
          visibleElements: elementData.filter(el => el.visible).slice(0, 100), // Limit to 100 visible elements
          allElements: elementData.slice(0, 500), // Limit to 500 elements total for performance
          forms: forms,
          canvasElements: canvasElements
        };
      });
      
      // Cache elements for future lookups
      for (const element of structure.visibleElements) {
        const selector = this.buildSelectorFromElement(element);
        if (selector && element.textContent) {
          this.elementCache.set(selector, { 
            text: element.textContent,
            tag: element.tag,
            id: element.id,
            name: element.name,
            attributes: element.attributes 
          });
        }
      }
      
      return structure;
    } catch (error) {
      logger.error(`Page structure error: ${error.message}`);
      throw new Error(`Failed to get page structure: ${error.message}`);
    }
  }
  
  /**
   * Build a selector from element information
   * @param {object} element - Element information
   * @returns {string} CSS selector
   */
  buildSelectorFromElement(element) {
    if (!element) return null;
    
    // Try ID first (most specific)
    if (element.id) {
      return `#${element.id}`;
    }
    
    // Use name attribute if available
    if (element.name) {
      return `${element.tag}[name="${element.name}"]`;
    }
    
    // Use ARIA attributes which are often reliable
    if (element.ariaLabel) {
      return `[aria-label="${element.ariaLabel}"]`;
    }
    
    if (element.attributes && element.attributes['aria-labelledby']) {
      return `[aria-labelledby="${element.attributes['aria-labelledby']}"]`;
    }
    
    // Form elements by placeholder
    if (element.placeholder) {
      return `[placeholder="${element.placeholder}"]`;
    }
    
    // Use title or alt text for images and other elements
    if (element.title) {
      return `[title="${element.title}"]`;
    }
    
    if (element.alt) {
      return `[alt="${element.alt}"]`;
    }
    
    // Check for data attributes which are often used for testing
    if (element.attributes) {
      for (const [name, value] of Object.entries(element.attributes)) {
        if (name.startsWith('data-')) {
          return `[${name}="${value}"]`;
        }
      }
    }
    
    // Use role attribute
    if (element.role) {
      return `[role="${element.role}"]`;
    }
    
    // Use text content for buttons and links
    if ((element.tag === 'button' || element.tag === 'a') && element.textContent) {
      return `${element.tag}:has-text("${element.textContent}")`;
    }
    
    // Use classes as a last resort
    if (element.className && typeof element.className === 'string') {
      const classes = element.className.split(' ').filter(c => c.trim());
      if (classes.length > 0) {
        return `${element.tag}.${classes.join('.')}`;
      }
    }
    
    // Fallback to tag name
    return element.tag;
  }

  /**
   * Execute JavaScript in the browser
   * @param {string} script - JavaScript to execute
   * @param {string} sessionId - Browser session ID
   * @returns {any} Result of the script execution
   */
  async executeScript(script, sessionId) {
    try {
      const session = this.getSession(sessionId);
      const result = await session.page.evaluate(script);
      logger.info(`Executed script (${sessionId})`);
      return { success: true, result };
    } catch (error) {
      logger.error(`Script execution error: ${error.message}`);
      throw new Error(`Failed to execute script: ${error.message}`);
    }
  }

  /**
   * Take a screenshot
   * @param {string} sessionId - Browser session ID
   * @returns {Buffer} Screenshot as Buffer
   */
  async takeScreenshot(sessionId) {
    try {
      const session = this.getSession(sessionId);
      const screenshot = await session.page.screenshot({ fullPage: true });
      logger.info(`Took screenshot (${sessionId})`);
      return screenshot;
    } catch (error) {
      logger.error(`Screenshot error: ${error.message}`);
      throw new Error(`Failed to take screenshot: ${error.message}`);
    }
  }

  /**
   * Close a browser session
   * @param {string} sessionId - Browser session ID to close
   */
  async closeBrowser(sessionId) {
    try {
      const session = this.getSession(sessionId);
      await session.browser.close();
      this.browsers.delete(sessionId);
      logger.info(`Browser closed: ${sessionId}`);
      return { success: true };
    } catch (error) {
      logger.error(`Close browser error: ${error.message}`);
      throw new Error(`Failed to close browser: ${error.message}`);
    }
  }

  /**
   * Close all active browser sessions
   */
  async closeAll() {
    try {
      const promises = [];
      for (const sessionId of this.browsers.keys()) {
        promises.push(this.closeBrowser(sessionId));
      }
      await Promise.all(promises);
      logger.info('All browsers closed');
      return { success: true };
    } catch (error) {
      logger.error(`Close all browsers error: ${error.message}`);
      throw new Error(`Failed to close all browsers: ${error.message}`);
    }
  }

  /**
   * Get a browser session
   * @param {string} sessionId - Browser session ID
   * @returns {object} Browser session object
   */
  getSession(sessionId) {
    const session = this.browsers.get(sessionId);
    if (!session) {
      throw new Error(`Browser session not found: ${sessionId}`);
    }
    return session;
  }

  /**
   * List all active browser sessions
   * @returns {Array} Array of active sessions
   */
  listSessions() {
    const sessions = [];
    for (const [id, session] of this.browsers.entries()) {
      sessions.push({
        sessionId: id,
        type: session.type,
        createdAt: session.createdAt
      });
    }
    return sessions;
  }

  /**
   * Draw on a canvas element
   * @param {string} selector - Canvas element selector
   * @param {Array} path - Array of points to draw [{x, y}, ...]
   * @param {object} options - Drawing options (color, lineWidth, etc.)
   * @param {string} sessionId - Browser session ID
   * @returns {object} Success status
   */
  async drawOnCanvas(selector, path, options = {}, sessionId) {
    try {
      const session = this.getSession(sessionId);
      
      // Find the canvas element
      const canvasSelector = await this.findBestSelector(selector, sessionId);
      if (!canvasSelector) {
        throw new Error(`Could not find canvas matching: ${selector}`);
      }
      
      // Set default options
      const drawingOptions = {
        color: options.color || '#000000',
        lineWidth: options.lineWidth || 2,
        lineCap: options.lineCap || 'round',
        lineJoin: options.lineJoin || 'round'
      };
      
      // Drawing script
      const result = await session.page.evaluate(
        ({ canvasSelector, path, options }) => {
          const canvas = document.querySelector(canvasSelector);
          if (!canvas) return { success: false, error: 'Canvas not found' };
          
          const ctx = canvas.getContext('2d');
          if (!ctx) return { success: false, error: 'Could not get canvas context' };
          
          // Set drawing styles
          ctx.strokeStyle = options.color;
          ctx.lineWidth = options.lineWidth;
          ctx.lineCap = options.lineCap;
          ctx.lineJoin = options.lineJoin;
          
          // Start drawing
          ctx.beginPath();
          
          // Move to first point
          if (path.length > 0) {
            ctx.moveTo(path[0].x, path[0].y);
          }
          
          // Draw lines to subsequent points
          for (let i = 1; i < path.length; i++) {
            ctx.lineTo(path[i].x, path[i].y);
          }
          
          // Stroke the path
          ctx.stroke();
          
          return { success: true };
        },
        { canvasSelector, path, options: drawingOptions }
      );
      
      if (!result.success) {
        throw new Error(result.error || 'Failed to draw on canvas');
      }
      
      logger.info(`Drew on canvas: ${canvasSelector} (${sessionId})`);
      return { success: true };
    } catch (error) {
      logger.error(`Draw on canvas error: ${error.message}`);
      throw new Error(`Failed to draw on canvas: ${error.message}`);
    }
  }
  
  /**
   * Find elements by name or attribute text (not just by selector)
   * @param {string} nameOrText - Text to search for in element names/attributes/content
   * @param {string} sessionId - Browser session ID
   * @returns {Array} Matching elements
   */
  async findElementsByNameOrText(nameOrText, sessionId) {
    try {
      const session = this.getSession(sessionId);
      
      // Get the page structure first
      const pageStructure = await this.getPageStructure(sessionId);
      
      // Filter elements by name, attribute text, or content text
      const searchText = nameOrText.toLowerCase();
      const matchingElements = pageStructure.visibleElements.filter(el => {
        // Check name attribute
        if (el.name && el.name.toLowerCase().includes(searchText)) return true;
        
        // Check ID attribute
        if (el.id && el.id.toLowerCase().includes(searchText)) return true;
        
        // Check text content
        if (el.textContent && el.textContent.toLowerCase().includes(searchText)) return true;
        
        // Check aria label
        if (el.ariaLabel && el.ariaLabel.toLowerCase().includes(searchText)) return true;
        
        // Check placeholder
        if (el.placeholder && el.placeholder.toLowerCase().includes(searchText)) return true;
        
        // Check title
        if (el.title && el.title.toLowerCase().includes(searchText)) return true;
        
        // Check alt text
        if (el.alt && el.alt.toLowerCase().includes(searchText)) return true;
        
        return false;
      });
      
      // Generate selectors for the matching elements
      const results = matchingElements.map(el => {
        const selector = this.buildSelectorFromElement(el);
        return {
          element: el,
          selector: selector,
          score: this.calculateElementMatchScore(el, searchText)
        };
      });
      
      // Sort by score (higher is better)
      results.sort((a, b) => b.score - a.score);
      
      return results;
    } catch (error) {
      logger.error(`Find elements by name/text error: ${error.message}`);
      throw new Error(`Failed to find elements by name/text: ${error.message}`);
    }
  }
  
  /**
   * Calculate how well an element matches the search text
   * @param {object} element - Element information
   * @param {string} searchText - Text to search for
   * @returns {number} Match score (higher is better)
   */
  calculateElementMatchScore(element, searchText) {
    let score = 0;
    
    // Exact matches are weighted more heavily
    if (element.name && element.name.toLowerCase() === searchText) score += 100;
    if (element.id && element.id.toLowerCase() === searchText) score += 100;
    if (element.textContent && element.textContent.toLowerCase() === searchText) score += 80;
    if (element.ariaLabel && element.ariaLabel.toLowerCase() === searchText) score += 90;
    if (element.placeholder && element.placeholder.toLowerCase() === searchText) score += 85;
    
    // Partial matches
    if (element.name && element.name.toLowerCase().includes(searchText)) score += 50;
    if (element.id && element.id.toLowerCase().includes(searchText)) score += 50;
    if (element.textContent && element.textContent.toLowerCase().includes(searchText)) score += 40;
    if (element.ariaLabel && element.ariaLabel.toLowerCase().includes(searchText)) score += 45;
    if (element.placeholder && element.placeholder.toLowerCase().includes(searchText)) score += 40;
    
    // Boost interactive elements
    if (element.tag === 'button' || element.tag === 'a' || element.tag === 'input') score += 30;
    if (element.role === 'button' || element.role === 'link') score += 25;
    
    // Penalize hidden elements
    if (!element.visible) score -= 100;
    
    return score;
  }

  /**
   * Analyze the context of the page and find the most appropriate element based on context
   * @param {string} description - Description of the element to find
   * @param {string} context - Context hint (e.g., "product search", "city search")
   * @param {string} sessionId - Browser session ID
   * @returns {object} Best matching element and its selector
   */
  async findElementInContext(description, context, sessionId) {
    try {
      const session = this.getSession(sessionId);
      
      // Get the current URL to understand website context
      const currentUrl = await session.page.url();
      const urlLower = currentUrl.toLowerCase();
      
      // Get all potential matching elements
      const matchingElements = await this.findElementsByNameOrText(description, sessionId);
      
      if (matchingElements.length === 0) {
        return null;
      }
      
      // Boost scores based on context
      const contextualResults = matchingElements.map(result => {
        let contextScore = result.score;
        const el = result.element;
        
        // E-commerce context adjustments
        if (context === 'product search' || urlLower.includes('amazon') || 
            urlLower.includes('ebay') || urlLower.includes('walmart')) {
          // Favor search boxes near the top of the page
          if (el.position.y < 200 && 
              (el.tag === 'input' || el.placeholder?.toLowerCase().includes('search'))) {
            contextScore += 50;
          }
          
          // Favor search boxes with shopping-related attributes
          if (el.placeholder?.toLowerCase().includes('product') || 
              el.name?.toLowerCase().includes('product') ||
              el.ariaLabel?.toLowerCase().includes('product')) {
            contextScore += 70;
          }
        }
        
        // Travel context adjustments
        if (context === 'city search' || urlLower.includes('booking') || 
            urlLower.includes('expedia') || urlLower.includes('airbnb')) {
          // Favor location/city inputs
          if (el.placeholder?.toLowerCase().includes('city') || 
              el.placeholder?.toLowerCase().includes('where') ||
              el.name?.toLowerCase().includes('city') ||
              el.name?.toLowerCase().includes('destination') ||
              el.id?.toLowerCase().includes('location')) {
            contextScore += 70;
          }
        }
        
        // Form context - boost elements inside the active form
        if (context === 'form' && el.parent) {
          const parentTag = el.parent.tag;
          if (parentTag === 'form') {
            contextScore += 40;
          }
        }
        
        return {
          ...result,
          contextScore
        };
      });
      
      // Sort by context-adjusted score
      contextualResults.sort((a, b) => b.contextScore - a.contextScore);
      
      // Return the best match with context consideration
      return contextualResults[0];
    } catch (error) {
      logger.error(`Find element in context error: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Apply filters to a product list (e.g., price range, ratings)
   * @param {object} filters - Filter criteria
   * @param {string} sessionId - Browser session ID
   * @returns {object} Filter application results
   */
  async applyProductFilters(filters, sessionId) {
    try {
      const session = this.getSession(sessionId);
      const currentUrl = await session.page.url();
      
      // Determine the e-commerce platform
      const platform = this.detectEcommercePlatform(currentUrl);
      
      // Initialize results
      const results = {
        appliedFilters: [],
        failedFilters: [],
        message: ''
      };
      
      // Handle price range filter
      if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
        try {
          await this.applyPriceRangeFilter(platform, filters.minPrice, filters.maxPrice, sessionId);
          results.appliedFilters.push('price range');
        } catch (error) {
          results.failedFilters.push('price range');
          logger.error(`Failed to apply price filter: ${error.message}`);
        }
      }
      
      // Handle sorting
      if (filters.sortBy) {
        try {
          await this.applySorting(platform, filters.sortBy, sessionId);
          results.appliedFilters.push(`sorting by ${filters.sortBy}`);
        } catch (error) {
          results.failedFilters.push(`sorting by ${filters.sortBy}`);
          logger.error(`Failed to apply sorting: ${error.message}`);
        }
      }
      
      // Handle rating filter
      if (filters.minRating) {
        try {
          await this.applyRatingFilter(platform, filters.minRating, sessionId);
          results.appliedFilters.push(`minimum rating of ${filters.minRating} stars`);
        } catch (error) {
          results.failedFilters.push(`minimum rating of ${filters.minRating} stars`);
          logger.error(`Failed to apply rating filter: ${error.message}`);
        }
      }
      
      // Update result message
      if (results.appliedFilters.length > 0) {
        results.message = `Successfully applied filters: ${results.appliedFilters.join(', ')}`;
      } else {
        results.message = 'Failed to apply any filters';
      }
      
      if (results.failedFilters.length > 0) {
        results.message += `. Failed filters: ${results.failedFilters.join(', ')}`;
      }
      
      return results;
    } catch (error) {
      logger.error(`Apply product filters error: ${error.message}`);
      throw new Error(`Failed to apply product filters: ${error.message}`);
    }
  }
  
  /**
   * Detect the e-commerce platform from the URL
   * @param {string} url - Current URL
   * @returns {string} Platform name ('amazon', 'ebay', 'walmart', 'generic')
   */
  detectEcommercePlatform(url) {
    const urlLower = url.toLowerCase();
    if (urlLower.includes('amazon')) return 'amazon';
    if (urlLower.includes('ebay')) return 'ebay';
    if (urlLower.includes('walmart')) return 'walmart';
    if (urlLower.includes('bestbuy')) return 'bestbuy';
    if (urlLower.includes('target')) return 'target';
    return 'generic';
  }
  
  /**
   * Apply price range filter based on the platform
   * @param {number} minPrice - Minimum price
   * @param {number} maxPrice - Maximum price
   * @param {string} sessionId - Browser session ID
   */
  async applyPriceRangeFilter(platform, minPrice, maxPrice, sessionId) {
    const session = this.getSession(sessionId);
    
    // Generic implementation for all platforms
    try {
      // Try to find min price input using common patterns
      if (minPrice !== undefined) {
        const minPriceSelectors = [
          'input[placeholder*="min" i]',
          'input[name*="min" i]',
          'input[id*="min" i]',
          'input[aria-label*="minimum" i]',
          'input[name*="low" i]',
          'input[placeholder="Min"]',
          'input[data-testid*="min" i]'
        ].join(', ');
        
        await this.fillField(minPriceSelectors, minPrice.toString(), sessionId);
      }
      
      // Try to find max price input using common patterns
      if (maxPrice !== undefined) {
        const maxPriceSelectors = [
          'input[placeholder*="max" i]',
          'input[name*="max" i]',
          'input[id*="max" i]',
          'input[aria-label*="maximum" i]',
          'input[name*="high" i]',
          'input[placeholder="Max"]',
          'input[data-testid*="max" i]'
        ].join(', ');
        
        await this.fillField(maxPriceSelectors, maxPrice.toString(), sessionId);
      }
      
      // Try to find and click a submit button
      const priceSubmitSelectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Apply")',
        'button:has-text("Go")',
        'button:has-text("Filter")',
        'a:has-text("Apply")',
        'button[aria-label*="price" i]',
        'input[aria-labelledby*="announce" i]'
      ].join(', ');
      
      await this.clickElement(priceSubmitSelectors, sessionId);
      
      // Wait for the page to update
      await session.page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch (error) {
      logger.warn(`Generic price filter application failed: ${error.message}. Trying alternative approach.`);
      
      // Alternative approach: Look for filter sections with price-related text
      try {
        // First find price filter section
        const priceFilterResult = await session.page.evaluate(() => {
          // Look for headers or section titles containing price-related text
          const priceTexts = ['price', 'cost', 'amount', '$'];
          const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"], legend'));
          
          for (const heading of headings) {
            const text = heading.textContent.toLowerCase();
            if (priceTexts.some(pt => text.includes(pt))) {
              // Found a price-related section, now look for inputs and submit buttons within/after it
              let section = heading.parentElement;
              let inputs = Array.from(section.querySelectorAll('input[type="text"], input[type="number"]'));
              
              if (inputs.length >= 1) {
                return {
                  found: true,
                  minInput: inputs[0],
                  maxInput: inputs.length > 1 ? inputs[1] : null
                };
              }
            }
          }
          
          return { found: false };
        });
        
        if (priceFilterResult.found) {
          // Use JavaScript execution to set values directly if found
          if (minPrice !== undefined) {
            await session.page.evaluate((min) => {
              const priceInputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"]'));
              const minInput = priceInputs.find(i => 
                i.id?.toLowerCase().includes('min') || 
                i.name?.toLowerCase().includes('min') || 
                i.placeholder?.toLowerCase().includes('min') ||
                i.id?.toLowerCase().includes('low') ||
                i.name?.toLowerCase().includes('low')
              );
              
              if (minInput) {
                minInput.value = min;
                minInput.dispatchEvent(new Event('input', { bubbles: true }));
                minInput.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }, minPrice.toString());
          }
          
          if (maxPrice !== undefined) {
            await session.page.evaluate((max) => {
              const priceInputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"]'));
              const maxInput = priceInputs.find(i => 
                i.id?.toLowerCase().includes('max') || 
                i.name?.toLowerCase().includes('max') || 
                i.placeholder?.toLowerCase().includes('max') ||
                i.id?.toLowerCase().includes('high') ||
                i.name?.toLowerCase().includes('high')
              );
              
              if (maxInput) {
                maxInput.value = max;
                maxInput.dispatchEvent(new Event('input', { bubbles: true }));
                maxInput.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }, maxPrice.toString());
          }
          
          // Find and click apply/submit button
          await session.page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a[role="button"]'));
            const applyButton = buttons.find(b => 
              b.textContent.toLowerCase().includes('apply') || 
              b.textContent.toLowerCase().includes('go') ||
              b.textContent.toLowerCase().includes('filter') || 
              b.textContent.toLowerCase().includes('submit') ||
              b.getAttribute('aria-label')?.toLowerCase().includes('apply')
            );
            
            if (applyButton) {
              applyButton.click();
            }
          });
          
          // Wait for the page to update
          await session.page.waitForLoadState('networkidle', { timeout: 10000 });
        }
      } catch (altError) {
        logger.error(`Alternative price filter approach failed: ${altError.message}`);
        throw new Error(`Could not apply price filters: ${error.message}`);
      }
    }
  }
  
  /**
   * Apply sorting to product listings
   * @param {string} sortBy - Sort criteria (price-low-high, price-high-low, rating, relevance)
   * @param {string} sessionId - Browser session ID
   */
  async applySorting(platform, sortBy, sessionId) {
    const session = this.getSession(sessionId);
    
    // Normalize the sort criteria
    const sortCriteria = sortBy.toLowerCase();
    
    try {
      // Step 1: Try to find and click a sort dropdown/button
      const sortDropdownSelectors = [
        'select[aria-label*="Sort" i]',
        'select[id*="sort" i]',
        'select[name*="sort" i]',
        'button[aria-label*="Sort" i]',
        'button[id*="sort" i]',
        '[data-test*="sort" i]',
        'span:has-text("Sort by:")',
        'div[id*="sort" i]',
        '[aria-label*="sort" i]',
        'button:has-text("Sort")',
        '.sort-dropdown'
      ].join(', ');
      
      await this.clickElement(sortDropdownSelectors, sessionId);
      
      // Wait for the dropdown to appear
      await session.page.waitForTimeout(500);
      
      // Step 2: Click on the appropriate sort option based on criteria
      let sortOptionSelector = '';
      
      if (sortCriteria.includes('price') && sortCriteria.includes('low')) {
        // Price low to high
        sortOptionSelector = [
          'option[value*="price_asc" i]',
          'option[value*="price-asc" i]',
          'option[value*="price_low" i]',
          'a:has-text("Price: Low to High")',
          'span:has-text("Price: Low to High")',
          'li:has-text("Price: Low to High")',
          '[data-value*="price_asc" i]',
          '[data-value*="price-asc" i]',
          '[data-value*="low" i]',
          'a[href*="price_asc" i]',
          'a[href*="price-asc" i]'
        ].join(', ');
      } else if (sortCriteria.includes('price') && sortCriteria.includes('high')) {
        // Price high to low
        sortOptionSelector = [
          'option[value*="price_desc" i]',
          'option[value*="price-desc" i]',
          'option[value*="price_high" i]',
          'a:has-text("Price: High to Low")',
          'span:has-text("Price: High to Low")',
          'li:has-text("Price: High to Low")',
          '[data-value*="price_desc" i]',
          '[data-value*="price-desc" i]',
          '[data-value*="high" i]',
          'a[href*="price_desc" i]',
          'a[href*="price-desc" i]'
        ].join(', ');
      } else if (sortCriteria.includes('rating') || sortCriteria.includes('review')) {
        // By ratings
        sortOptionSelector = [
          'option[value*="rating" i]',
          'option[value*="review" i]',
          'option[value*="review-rank" i]',
          'a:has-text("Top Rated")',
          'span:has-text("Customer Rating")',
          'li:has-text("Best Reviewed")',
          '[data-value*="rating" i]',
          '[data-value*="review" i]',
          'a[href*="rating" i]',
          'a[href*="review" i]'
        ].join(', ');
      } else if (sortCriteria.includes('new') || sortCriteria.includes('recent')) {
        // By newest
        sortOptionSelector = [
          'option[value*="date_desc" i]',
          'option[value*="date-desc" i]',
          'option[value*="newest" i]',
          'option[value*="recently" i]',
          'a:has-text("Newest")',
          'span:has-text("Newest")',
          'li:has-text("Recently")',
          '[data-value*="date_desc" i]',
          '[data-value*="date-desc" i]',
          '[data-value*="newest" i]',
          'a[href*="date_desc" i]',
          'a[href*="date-desc" i]',
          'a[href*="newly" i]'
        ].join(', ');
      } else {
        // Default to relevance
        sortOptionSelector = [
          'option[value*="relevance" i]',
          'option[value*="best_match" i]',
          'option[value*="best-match" i]',
          'a:has-text("Relevance")',
          'span:has-text("Best Match")',
          'li:has-text("Most Relevant")',
          '[data-value*="relevance" i]',
          '[data-value*="featured" i]',
          '[data-value*="best_match" i]',
          'a[href*="relevance" i]',
          'a[href*="best_match" i]',
          'a[href*="best-match" i]'
        ].join(', ');
      }
      
      await this.clickElement(sortOptionSelector, sessionId);
      
      // Wait for the page to update
      await session.page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch (error) {
      logger.warn(`Primary sorting approach failed: ${error.message}. Trying alternative approach.`);
      
      // Alternative approach: Try to find the sorting mechanism directly
      try {
        await session.page.evaluate((sortType) => {
          // Try to find sort controls
          const sortControls = Array.from(document.querySelectorAll('select, [role="listbox"], [role="combobox"]'));
          
          // If we found a dropdown
          for (const control of sortControls) {
            // Check if it's a sort control
            const controlText = control.textContent.toLowerCase();
            const controlId = control.id ? control.id.toLowerCase() : '';
            const isSort = controlText.includes('sort') || controlId.includes('sort');
            
            if (isSort) {
              // For dropdowns
              if (control.tagName === 'SELECT') {
                const options = Array.from(control.options);
                
                // Find matching option
                let targetOption = null;
                
                if (sortType.includes('price') && sortType.includes('low')) {
                  targetOption = options.find(opt => 
                    (opt.textContent.toLowerCase().includes('price') && opt.textContent.toLowerCase().includes('low')) ||
                    (opt.value.toLowerCase().includes('price') && opt.value.toLowerCase().includes('asc'))
                  );
                } else if (sortType.includes('price') && sortType.includes('high')) {
                  targetOption = options.find(opt => 
                    (opt.textContent.toLowerCase().includes('price') && opt.textContent.toLowerCase().includes('high')) ||
                    (opt.value.toLowerCase().includes('price') && opt.value.toLowerCase().includes('desc'))
                  );
                } else if (sortType.includes('rating') || sortType.includes('review')) {
                  targetOption = options.find(opt => 
                    opt.textContent.toLowerCase().includes('rating') || 
                    opt.textContent.toLowerCase().includes('review') ||
                    opt.value.toLowerCase().includes('rating') ||
                    opt.value.toLowerCase().includes('review')
                  );
                } else if (sortType.includes('new') || sortType.includes('recent')) {
                  targetOption = options.find(opt => 
                    opt.textContent.toLowerCase().includes('new') || 
                    opt.textContent.toLowerCase().includes('recent') ||
                    opt.value.toLowerCase().includes('date') ||
                    opt.value.toLowerCase().includes('new')
                  );
                } else {
                  targetOption = options.find(opt => 
                    opt.textContent.toLowerCase().includes('relevan') || 
                    opt.textContent.toLowerCase().includes('featured') ||
                    opt.textContent.toLowerCase().includes('best match')
                  );
                }
                
                if (targetOption) {
                  control.value = targetOption.value;
                  control.dispatchEvent(new Event('change', { bubbles: true }));
                  return true;
                }
              } 
              // For custom dropdowns, click to expand
              else {
                control.click();
                return true; // we'll handle the next step separately
              }
            }
          }
          
          return false;
        }, sortCriteria);
        
        // If we've clicked to expand a custom dropdown, now click the option
        await session.page.waitForTimeout(500);
        
        // Build option selectors based on sort criteria
        let optionTextPattern = '';
        
        if (sortCriteria.includes('price') && sortCriteria.includes('low')) {
          optionTextPattern = /(price.*low|low.*price|price.*asc|ascending.*price)/i;
        } else if (sortCriteria.includes('price') && sortCriteria.includes('high')) {
          optionTextPattern = /(price.*high|high.*price|price.*desc|descending.*price)/i;
        } else if (sortCriteria.includes('rating') || sortCriteria.includes('review')) {
          optionTextPattern = /(rating|review|stars|top rated)/i;
        } else if (sortCriteria.includes('new') || sortCriteria.includes('recent')) {
          optionTextPattern = /(newest|recent|latest|new arrivals|date)/i;
        } else {
          optionTextPattern = /(relevance|featured|best match|recommended)/i;
        }
        
        await session.page.evaluate((pattern) => {
          const patternRegex = new RegExp(pattern);
          const options = Array.from(document.querySelectorAll('li, div[role="option"], a, span, button'));
          
          // Find an option that matches our pattern
          const targetOption = options.find(opt => patternRegex.test(opt.textContent));
          if (targetOption) {
            targetOption.click();
            return true;
          }
          
          return false;
        }, optionTextPattern.source);
        
        // Wait for the page to update after sort change
        await session.page.waitForLoadState('networkidle', { timeout: 10000 });
      } catch (altError) {
        logger.error(`Alternative sorting approach failed: ${altError.message}`);
        throw new Error(`Could not apply sorting: ${error.message}`);
      }
    }
  }
  
  /**
   * Apply rating filter
   * @param {number} minRating - Minimum rating (1-5)
   * @param {string} sessionId - Browser session ID
   */
  async applyRatingFilter(platform, minRating, sessionId) {
    const session = this.getSession(sessionId);
    
    try {
      // Generic approach to find rating filters across different platforms
      const ratingSelectors = [
        `input[type="checkbox"][id*="star"][id*="${minRating}"]`,
        `span:has-text("${minRating} star")`,
        `label:has-text("${minRating} star")`,
        `a:has-text("${minRating} star")`,
        `[aria-label*="${minRating} star"]`,
        `span:has-text("${minRating} Stars & Up")`,
        `a:has-text("${minRating} Stars & Up")`,
        `span:has-text("${minRating}.0")`,
        `a:has-text("${minRating}.0")`
      ].join(', ');
      
      await this.clickElement(ratingSelectors, sessionId);
      
      // Wait for the page to update
      await session.page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch (error) {
      logger.warn(`Primary rating filter approach failed: ${error.message}. Trying alternative approach.`);
      
      // Alternative approach: Look for rating filter sections and interact with them directly
      try {
        // First find rating filter section
        const ratingFilterResult = await session.page.evaluate((rating) => {
          // Look for headers or section titles containing rating-related text
          const ratingTexts = ['rating', 'stars', 'review', 'customer review'];
          const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"], legend'));
          
          for (const heading of headings) {
            const text = heading.textContent.toLowerCase();
            if (ratingTexts.some(rt => text.includes(rt))) {
              // Found a rating-related section, now look for appropriate options
              let section = heading.closest('section') || heading.closest('div') || heading.parentElement;
              
              // Look for star patterns with our rating
              const ratingPattern = new RegExp(`${rating}\\s*star|${rating}\\s*stars|${rating}\\.0`);
              
              // Find clickable elements within the section that match our rating
              const clickables = Array.from(section.querySelectorAll('input, label, a, button, span[role="button"]'));
              const matchingElement = clickables.find(el => {
                // Check the element text
                const elText = el.textContent.toLowerCase() || '';
                if (ratingPattern.test(elText)) return true;
                
                // Check attributes
                if (el.id && ratingPattern.test(el.id)) return true;
                if (el.name && ratingPattern.test(el.name)) return true;
                if (el.getAttribute('aria-label') && ratingPattern.test(el.getAttribute('aria-label'))) return true;
                
                return false;
              });
              
              if (matchingElement) {
                // Calculate the element's position for a click
                const rect = matchingElement.getBoundingClientRect();
                return {
                  found: true,
                  x: rect.left + (rect.width / 2),
                  y: rect.top + (rect.height / 2)
                };
              }
            }
          }
          
          return { found: false };
        }, minRating);
        
        if (ratingFilterResult.found) {
          // Click at the calculated position
          await session.page.mouse.click(ratingFilterResult.x, ratingFilterResult.y);
          
          // Wait for the page to update
          await session.page.waitForLoadState('networkidle', { timeout: 10000 });
        } else {
          // If we still can't find a suitable element, try one more approach
          // Look for star rating elements directly
          await session.page.evaluate((rating) => {
            // Look for elements with star images or icons
            const starElements = Array.from(document.querySelectorAll(
              '[class*="star" i], [id*="star" i], [aria-label*="star" i], [title*="star" i]'
            ));
            
            for (const starEl of starElements) {
              // Check if this is a filter element
              const parent = starEl.closest('div') || starEl.parentElement;
              const text = parent.textContent.toLowerCase();
              
              if (text.includes(`${rating} star`) || text.includes(`${rating}.0`) || text.includes(`${rating} and up`)) {
                // This looks like our target - click it
                starEl.click();
                return true;
              }
            }
            
            return false;
          }, minRating);
          
          // Wait for the page to update
          await session.page.waitForLoadState('networkidle', { timeout: 10000 });
        }
      } catch (altError) {
        logger.error(`Alternative rating filter approach failed: ${altError.message}`);
        throw new Error(`Could not apply rating filter: ${error.message}`);
      }
    }
  }
  
  /**
   * Select a product by budget constraints
   * @param {number} budget - Maximum budget
   * @param {object} options - Additional selection criteria
   * @param {string} sessionId - Browser session ID
   * @returns {object} Selected product information
   */
  async selectProductByBudget(budget, options = {}, sessionId) {
    try {
      const session = this.getSession(sessionId);
      
      // Default options
      const selectionOptions = {
        preferHighRated: true,
        preferBestSeller: true,
        minRating: 4,
        ...options
      };
      
      // Extract all products with prices from the page
      const products = await session.page.evaluate((budget) => {
        // Helper function to extract price from text
        const extractPrice = (text) => {
          const priceMatch = text.match(/\$\s*(\d+(?:\.\d+)?)/);
          return priceMatch ? parseFloat(priceMatch[1]) : null;
        };
        
        // Find all product elements on the page
        const productElements = Array.from(document.querySelectorAll(
          '[data-component-type="s-search-result"], .s-result-item, .product-item, .product-card, [data-testid="product-card"]'
        ));
        
        return productElements.map(el => {
          // Extract price
          const priceEl = el.querySelector('.a-price, .price, [data-testid="price"]');
          const priceText = priceEl ? priceEl.textContent : '';
          const price = extractPrice(priceText);
          
          // Extract rating
          const ratingEl = el.querySelector('.a-star-rating, .rating, [data-testid="rating"]');
          const ratingText = ratingEl ? ratingEl.textContent : '';
          const ratingMatch = ratingText.match(/(\d+(?:\.\d+)?)\s*out of\s*(\d+)|(\d+(?:\.\d+)?)\s*stars?/i);
          const rating = ratingMatch ? parseFloat(ratingMatch[1] || ratingMatch[3]) : null;
          
          // Extract title
          const titleEl = el.querySelector('.a-text-normal, .product-title, [data-testid="title"]');
          const title = titleEl ? titleEl.textContent.trim() : '';
          
          // Check if best seller
          const isBestSeller = el.textContent.toLowerCase().includes('best seller');
          
          // Get the element's position and size
          const rect = el.getBoundingClientRect();
          
          return {
            price,
            rating,
            title,
            isBestSeller,
            withinBudget: price !== null && price <= budget,
            element: el,
            position: {
              top: rect.top,
              left: rect.left
            }
          };
        }).filter(product => product.price !== null); // Filter out products without price
      }, budget);
      
      // Filter products within budget
      const affordableProducts = products.filter(p => p.withinBudget);
      
      if (affordableProducts.length === 0) {
        return {
          success: false,
          message: `No products found within budget of $${budget}`
        };
      }
      
      // Sort products based on selection criteria
      let sortedProducts = affordableProducts.slice();
      
      if (selectionOptions.preferHighRated) {
        // Sort by rating (descending)
        sortedProducts.sort((a, b) => {
          // First by rating
          const ratingDiff = (b.rating || 0) - (a.rating || 0);
          if (ratingDiff !== 0) return ratingDiff;
          
          // Then by best seller status
          if (selectionOptions.preferBestSeller) {
            if (a.isBestSeller && !b.isBestSeller) return -1;
            if (!a.isBestSeller && b.isBestSeller) return 1;
          }
          
          // Finally by price (closer to budget is better)
          return budget - a.price - (budget - b.price);
        });
      } else {
        // Sort by price (descending) to get the most value for money
        sortedProducts.sort((a, b) => {
          // First by price
          const priceDiff = b.price - a.price;
          if (priceDiff !== 0) return priceDiff;
          
          // Then by rating
          return (b.rating || 0) - (a.rating || 0);
        });
      }
      
      // Filter by minimum rating if specified
      if (selectionOptions.minRating > 0) {
        const highRatedProducts = sortedProducts.filter(p => 
          p.rating !== null && p.rating >= selectionOptions.minRating
        );
        
        if (highRatedProducts.length > 0) {
          sortedProducts = highRatedProducts;
        }
      }
      
      // Select the best product
      const selectedProduct = sortedProducts[0];
      
      // Click on the selected product
      await session.page.evaluate((position) => {
        // Find element at this position
        const elementAtPosition = document.elementFromPoint(
          position.left + 10, 
          position.top + 10
        );
        
        if (elementAtPosition) {
          // Find the closest clickable ancestor
          let clickableElement = elementAtPosition;
          while (clickableElement && clickableElement.tagName !== 'A' && 
                 clickableElement.tagName !== 'BUTTON') {
            clickableElement = clickableElement.parentElement;
          }
          
          // Click the element
          if (clickableElement) {
            clickableElement.click();
          } else {
            elementAtPosition.click();
          }
        }
      }, selectedProduct.position);
      
      // Wait for the page to navigate
      await session.page.waitForNavigation({ timeout: 10000 });
      
      return {
        success: true,
        product: {
          title: selectedProduct.title,
          price: selectedProduct.price,
          rating: selectedProduct.rating,
          isBestSeller: selectedProduct.isBestSeller
        },
        message: `Selected product "${selectedProduct.title}" for $${selectedProduct.price}`
      };
    } catch (error) {
      logger.error(`Select product by budget error: ${error.message}`);
      throw new Error(`Failed to select product by budget: ${error.message}`);
    }
  }
}

module.exports = BrowserController; 