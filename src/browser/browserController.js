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
      
      // Click the element
      await session.page.click(resolvedSelector);
      
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
   * Find the best selector for an element
   * @param {string} selector - Initial selector or description
   * @param {string} sessionId - Browser session ID  
   * @returns {string|null} Best matching selector or null if not found
   */
  async findBestSelector(selector, sessionId) {
    const session = this.getSession(sessionId);
    
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
    
    // Step 5: Try to find by analyzing the page structure
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
   * Generate alternative selectors for an element
   * @param {string} originalSelector - Original selector
   * @returns {Array} Array of alternative selectors
   */
  generateAlternativeSelectors(originalSelector) {
    const alternatives = [];
    const lowerSelector = originalSelector.toLowerCase();
    
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
      alternatives.push('button:visible');
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
      alternatives.push('a:visible');
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
      alternatives.push('input:visible');
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
    
    return alternatives;
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
}

module.exports = BrowserController; 