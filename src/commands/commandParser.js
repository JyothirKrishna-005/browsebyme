/**
 * Command Parser - Interprets text commands and calls appropriate browser actions
 */
const natural = require('natural');
const { logger } = require('../utils/logger');
const { extractEntities } = require('../utils/nlpHelper');

class CommandParser {
  constructor(browserController) {
    this.browserController = browserController;
    this.activeSession = null;
    this.tokenizer = new natural.WordTokenizer();
    
    // Command patterns for basic intent recognition
    this.commandPatterns = {
      open: [
        'open', 'launch', 'start', 'create', 'new'
      ],
      navigate: [
        'go to', 'navigate to', 'visit', 'open', 'browse', 'load'
      ],
      click: [
        'click', 'press', 'select', 'choose', 'tap', 'push'
      ],
      type: [
        'type', 'enter', 'input', 'fill', 'write'
      ],
      search: [
        'search', 'find', 'look for', 'query'
      ],
      book: [
        'book', 'reserve', 'purchase', 'buy'
      ],
      close: [
        'close', 'exit', 'quit', 'end'
      ],
      screenshot: [
        'screenshot', 'capture', 'take picture', 'snap'
      ],
      scroll: [
        'scroll', 'move', 'swipe'
      ],
      wait: [
        'wait', 'pause', 'delay', 'sleep'
      ]
    };
  }

  /**
   * Parse and execute a text command
   * @param {string} command - Text command to execute
   * @returns {object} Command execution result
   */
  async parseAndExecute(command) {
    try {
      logger.info(`Parsing command: ${command}`);
      
      // Normalize command to lowercase
      const normalizedCommand = command.toLowerCase();
      
      // Determine the intent of the command
      const intent = this.determineIntent(normalizedCommand);
      logger.info(`Detected intent: ${intent.type}`);
      
      // Execute command based on intent
      return await this.executeCommand(intent, normalizedCommand);
    } catch (error) {
      logger.error(`Command parser error: ${error.message}`);
      throw new Error(`Failed to parse command: ${error.message}`);
    }
  }

  /**
   * Determine the intent of a command
   * @param {string} command - Text command to analyze
   * @returns {object} Intent object with type and confidence
   */
  determineIntent(command) {
    let highestConfidence = 0;
    let detectedIntent = 'unknown';

    // Check each intent pattern
    for (const [intent, patterns] of Object.entries(this.commandPatterns)) {
      for (const pattern of patterns) {
        if (command.includes(pattern)) {
          // Calculate a better confidence score
          // Words that appear at the start of the command get more weight
          const wordPosition = command.indexOf(pattern) / command.length;
          const lengthScore = pattern.length / command.length;
          const confidence = lengthScore * (1 - wordPosition * 0.5);
          
          if (confidence > highestConfidence) {
            highestConfidence = confidence;
            detectedIntent = intent;
          }
        }
      }
    }

    // If we still haven't determined an intent but there's a URL in the command, 
    // assume it's a navigate command
    if (detectedIntent === 'unknown' && this.extractUrl(command)) {
      detectedIntent = 'navigate';
      highestConfidence = 0.5;
    }

    return {
      type: detectedIntent,
      confidence: highestConfidence
    };
  }

  /**
   * Execute a command based on detected intent
   * @param {object} intent - Intent object with type and confidence
   * @param {string} command - Original text command
   * @returns {object} Command execution result
   */
  async executeCommand(intent, command) {
    switch (intent.type) {
      case 'open':
        return await this.handleOpenCommand(command);
      
      case 'navigate':
        return await this.handleNavigateCommand(command);
      
      case 'click':
        return await this.handleClickCommand(command);
      
      case 'type':
        return await this.handleTypeCommand(command);
      
      case 'search':
        return await this.handleSearchCommand(command);
      
      case 'book':
        return await this.handleBookCommand(command);
      
      case 'close':
        return await this.handleCloseCommand(command);
      
      case 'screenshot':
        return await this.handleScreenshotCommand(command);
        
      case 'scroll':
        return await this.handleScrollCommand(command);
        
      case 'wait':
        return await this.handleWaitCommand(command);
      
      default:
        throw new Error(`Unknown command intent: ${intent.type} - Please try being more specific`);
    }
  }

  /**
   * Handle "open" commands
   * @param {string} command - Text command
   * @returns {object} Command execution result
   */
  async handleOpenCommand(command) {
    // Determine browser type
    let browserType = 'chromium'; // Default
    
    if (command.includes('firefox')) {
      browserType = 'firefox';
    } else if (command.includes('safari') || command.includes('webkit')) {
      browserType = 'webkit';
    } else if (command.includes('edge')) {
      browserType = 'edge';
    } else if (command.includes('chrome')) {
      browserType = 'chrome';
    }
    
    // Launch the browser
    const result = await this.browserController.launchBrowser(browserType);
    this.activeSession = result.sessionId;
    
    return {
      action: 'open',
      browserType,
      sessionId: result.sessionId,
      message: `Opened ${browserType} browser`
    };
  }

  /**
   * Handle "navigate" commands
   * @param {string} command - Text command
   * @returns {object} Command execution result
   */
  async handleNavigateCommand(command) {
    // Extract URL from command
    let url = this.extractUrl(command);
    
    // If we couldn't find a URL, try to treat the command as a search query
    if (!url) {
      // Extract everything after "go to", "open", etc.
      const navigatePatterns = ['go to', 'navigate to', 'visit', 'open', 'browse', 'load'];
      for (const pattern of navigatePatterns) {
        if (command.includes(pattern)) {
          const afterPattern = command.substring(command.indexOf(pattern) + pattern.length).trim();
          if (afterPattern) {
            // If it seems like a domain (contains a dot and no spaces), try it as a URL
            if (afterPattern.includes('.') && !afterPattern.includes(' ')) {
              url = afterPattern;
            } else {
              // Otherwise, search Google for it
              return await this.handleSearchCommand(afterPattern);
            }
          }
        }
      }
    }
    
    // If we still don't have a URL, tell the user
    if (!url) {
      throw new Error('No URL found in command. Try "go to example.com" or "open https://example.com"');
    }
    
    // Ensure URL has protocol
    if (url && !url.startsWith('http')) {
      url = 'https://' + url;
    }
    
    // Check if we have an active session, create one if not
    if (!this.activeSession) {
      const session = await this.browserController.launchBrowser();
      this.activeSession = session.sessionId;
    }
    
    // Navigate to URL
    const result = await this.browserController.navigateTo(url, this.activeSession);
    
    return {
      action: 'navigate',
      url: result.url,
      title: result.title,
      message: `Navigated to ${result.url}`
    };
  }

  /**
   * Handle "click" commands
   * @param {string} command - Text command
   * @returns {object} Command execution result
   */
  async handleClickCommand(command) {
    // Check if we have an active session
    if (!this.activeSession) {
      throw new Error('No active browser session. Try "open chrome" first.');
    }
    
    // Extract selector from command - more sophisticated approach
    let selector = null;
    
    // Check for specific targets like "first result", "login button", etc.
    if (command.includes('first') && command.includes('result')) {
      selector = '.g:first-child a, [data-hveid]:first-child a, [data-ved]:first-child a, .yuRUbf:first-child a';
    } else if (command.includes('login') && command.includes('button')) {
      selector = '[type="submit"], button:contains("Login"), button:contains("Sign in"), .login-button, .signin-button';
    } else if (command.includes('search') && command.includes('button')) {
      selector = '[type="submit"], button:contains("Search"), button:contains("Go"), .search-button';
    } else if (command.includes('accept') && (command.includes('cookies') || command.includes('terms'))) {
      selector = 'button:contains("Accept"), button:contains("Allow"), button:contains("Agree"), .accept-button';
    } else {
      // If no specific pattern, try general extraction
      selector = this.extractSelector(command);
    }
    
    if (!selector) {
      throw new Error('Could not determine what to click. Please be more specific, e.g., "click the login button".');
    }
    
    // Click element
    await this.browserController.clickElement(selector, this.activeSession);
    
    return {
      action: 'click',
      selector,
      message: `Clicked element: ${selector}`
    };
  }

  /**
   * Handle "type" commands
   * @param {string} command - Text command
   * @returns {object} Command execution result
   */
  async handleTypeCommand(command) {
    // Check if we have an active session
    if (!this.activeSession) {
      throw new Error('No active browser session. Try "open chrome" first.');
    }
    
    // Extract selector and text
    const { selector, text } = this.extractSelectorAndText(command);
    
    if (!text) {
      throw new Error('No text found to type. Please specify what to type, e.g., "type hello in the search box".');
    }
    
    if (!selector) {
      throw new Error('No input field specified. Please specify where to type, e.g., "type hello in the search box".');
    }
    
    // Fill field
    await this.browserController.fillField(selector, text, this.activeSession);
    
    return {
      action: 'type',
      selector,
      text,
      message: `Typed "${text}" into ${selector}`
    };
  }

  /**
   * Handle "search" commands
   * @param {string} command - Text command
   * @returns {object} Command execution result
   */
  async handleSearchCommand(command) {
    // Extract search query
    const query = this.extractSearchQuery(command);
    
    if (!query) {
      throw new Error('No search query found. Please specify what to search for, e.g., "search for best laptops".');
    }
    
    // Check if we have an active session, create one if not
    if (!this.activeSession) {
      const session = await this.browserController.launchBrowser();
      this.activeSession = session.sessionId;
    }
    
    // Navigate to Google and perform search
    await this.browserController.navigateTo('https://www.google.com', this.activeSession);
    
    // Give the page a moment to load fully
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Try to find and fill the search box
    try {
      await this.browserController.fillField('input[name="q"]', query, this.activeSession);
      
      // Try to click the search button
      try {
        await this.browserController.clickElement('input[name="btnK"], button[name="btnK"], input[type="submit"], button[type="submit"]', this.activeSession);
      } catch (clickError) {
        // If clicking failed, try pressing Enter
        await this.browserController.executeScript(`
          const input = document.querySelector('input[name="q"]');
          if (input) {
            input.focus();
            const event = new KeyboardEvent('keydown', { 'key': 'Enter', 'code': 'Enter', 'keyCode': 13, 'which': 13, 'bubbles': true });
            input.dispatchEvent(event);
          }
        `, this.activeSession);
      }
    } catch (error) {
      logger.error(`Search error: ${error.message}`);
      throw new Error(`Failed to perform search: ${error.message}`);
    }
    
    return {
      action: 'search',
      query,
      message: `Searched for "${query}"`
    };
  }

  /**
   * Handle "book" commands
   * @param {string} command - Text command
   * @returns {object} Command execution result
   */
  async handleBookCommand(command) {
    // Check if we have an active session
    if (!this.activeSession) {
      throw new Error('No active browser session. Try "open chrome" first.');
    }
    
    // Extract booking details using NLP
    const entities = extractEntities(command);
    
    // Create a description of what we understand
    let bookingDescription = 'Booking task initiated:';
    
    if (entities.products && entities.products.length > 0) {
      bookingDescription += `\n- Product: ${entities.products[0]}`;
    }
    
    if (entities.numbers && entities.numbers.length > 0) {
      bookingDescription += `\n- Quantity: ${entities.numbers[0]}`;
    }
    
    if (entities.dates && entities.dates.length > 0) {
      bookingDescription += `\n- Date: ${entities.dates[0]}`;
    }
    
    if (entities.times && entities.times.length > 0) {
      bookingDescription += `\n- Time: ${entities.times[0]}`;
    }
    
    if (entities.locations && entities.locations.length > 0) {
      bookingDescription += `\n- Location: ${entities.locations[0]}`;
    }
    
    // For a booking task, we'd have to implement site-specific flows
    // This is a complex task that would require more specific implementations
    // For now, we'll just return the entities we've extracted
    
    return {
      action: 'book',
      entities,
      message: bookingDescription,
      note: 'Complex booking tasks require additional implementation'
    };
  }

  /**
   * Handle "close" commands
   * @param {string} command - Text command
   * @returns {object} Command execution result
   */
  async handleCloseCommand(command) {
    // Check if we're closing all browsers
    const closeAll = command.includes('all');
    
    if (closeAll) {
      await this.browserController.closeAll();
      this.activeSession = null;
      
      return {
        action: 'close',
        target: 'all',
        message: 'Closed all browser sessions'
      };
    } else if (this.activeSession) {
      await this.browserController.closeBrowser(this.activeSession);
      this.activeSession = null;
      
      return {
        action: 'close',
        target: 'active',
        message: 'Closed active browser session'
      };
    } else {
      throw new Error('No active browser session to close');
    }
  }

  /**
   * Handle "screenshot" commands
   * @param {string} command - Text command
   * @returns {object} Command execution result
   */
  async handleScreenshotCommand(command) {
    // Check if we have an active session
    if (!this.activeSession) {
      throw new Error('No active browser session. Try "open chrome" first.');
    }
    
    // Take screenshot
    const screenshot = await this.browserController.takeScreenshot(this.activeSession);
    
    // In a real application, we would save this somewhere or return it to the client
    // For now, just return a success message
    return {
      action: 'screenshot',
      message: 'Screenshot captured successfully'
    };
  }

  /**
   * Handle "scroll" commands
   * @param {string} command - Text command
   * @returns {object} Command execution result
   */
  async handleScrollCommand(command) {
    // Check if we have an active session
    if (!this.activeSession) {
      throw new Error('No active browser session. Try "open chrome" first.');
    }
    
    const session = this.browserController.getSession(this.activeSession);
    
    // Determine scroll direction and amount
    let scrollY = 500; // Default scroll amount
    let scrollX = 0;
    
    if (command.includes('down')) {
      scrollY = 500;
    } else if (command.includes('up')) {
      scrollY = -500;
    } else if (command.includes('left')) {
      scrollX = -500;
      scrollY = 0;
    } else if (command.includes('right')) {
      scrollX = 500;
      scrollY = 0;
    }
    
    // Check for specific amounts
    const numberMatch = command.match(/(\d+)\s*(px|pixels)?/i);
    if (numberMatch) {
      const amount = parseInt(numberMatch[1], 10);
      if (command.includes('up')) {
        scrollY = -amount;
      } else if (command.includes('left')) {
        scrollX = -amount;
        scrollY = 0;
      } else if (command.includes('right')) {
        scrollX = amount;
        scrollY = 0;
      } else {
        scrollY = amount;
      }
    }
    
    // Scroll the page
    await session.page.evaluate(({ x, y }) => {
      window.scrollBy(x, y);
    }, { x: scrollX, y: scrollY });
    
    return {
      action: 'scroll',
      direction: scrollY > 0 ? 'down' : scrollY < 0 ? 'up' : scrollX > 0 ? 'right' : 'left',
      amount: Math.abs(scrollY || scrollX),
      message: `Scrolled ${scrollY > 0 ? 'down' : scrollY < 0 ? 'up' : scrollX > 0 ? 'right' : 'left'} by ${Math.abs(scrollY || scrollX)}px`
    };
  }

  /**
   * Handle "wait" commands
   * @param {string} command - Text command
   * @returns {object} Command execution result
   */
  async handleWaitCommand(command) {
    // Check if we have an active session
    if (!this.activeSession) {
      throw new Error('No active browser session. Try "open chrome" first.');
    }
    
    // Determine wait time
    let waitTime = 2000; // Default: 2 seconds
    
    const numberMatch = command.match(/(\d+)\s*(s|sec|seconds|ms|milliseconds)?/i);
    if (numberMatch) {
      const amount = parseInt(numberMatch[1], 10);
      const unit = numberMatch[2] ? numberMatch[2].toLowerCase() : 's';
      
      if (unit === 'ms' || unit === 'milliseconds') {
        waitTime = amount;
      } else {
        waitTime = amount * 1000; // Convert seconds to milliseconds
      }
    }
    
    // Cap wait time at 30 seconds for safety
    waitTime = Math.min(waitTime, 30000);
    
    // Wait
    await new Promise(resolve => setTimeout(resolve, waitTime));
    
    return {
      action: 'wait',
      duration: waitTime,
      message: `Waited for ${waitTime / 1000} seconds`
    };
  }

  /**
   * Extract URL from command
   * @param {string} command - Text command
   * @returns {string|null} Extracted URL or null
   */
  extractUrl(command) {
    // First pattern: Match common URL patterns with or without protocol
    const urlPattern = /(?:https?:\/\/)?(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&//=]*)/i;
    const urlMatch = command.match(urlPattern);
    
    if (urlMatch) {
      return urlMatch[0];
    }
    
    // Second pattern: Look for URLs after common phrases
    const phrasePattern = /(?:go to|open|visit|navigate to|browse)\s+(?:https?:\/\/)?([a-zA-Z0-9][-a-zA-Z0-9]*\.)?[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}(?:\/[-a-zA-Z0-9:%_\+.~#?&//=]*)?/i;
    const phraseMatch = command.match(phrasePattern);
    
    if (phraseMatch) {
      // Extract the domain part
      const urlPart = phraseMatch[0].split(/\s+/).slice(-1)[0];
      return urlPart;
    }
    
    return null;
  }

  /**
   * Extract selector from command
   * @param {string} command - Text command
   * @returns {string|null} Extracted selector or null
   */
  extractSelector(command) {
    // Look for common UI element descriptions
    if (command.includes('button')) {
      // Try to extract a specific button text
      const buttonTextMatch = command.match(/(?:button|btn)(?:\s+(?:with|that says|labeled|containing))?\s+['"]?([^'"]+)['"]?/i);
      if (buttonTextMatch) {
        const buttonText = buttonTextMatch[1].trim();
        return `button:has-text("${buttonText}"), [role="button"]:has-text("${buttonText}"), input[type="button"][value*="${buttonText}" i], .button:has-text("${buttonText}")`;
      }
      return 'button, input[type="button"], input[type="submit"], [role="button"]';
    } else if (command.includes('search box') || command.includes('search field')) {
      return 'input[type="search"], input[name="q"], input[placeholder*="search" i], [aria-label*="search" i]';
    } else if (command.includes('link')) {
      // Extract link text
      const linkTextMatch = command.match(/link\s+(?:with|that says|saying|containing|to)\s+['"]?([^'"]+)['"]?/i);
      if (linkTextMatch) {
        const linkText = linkTextMatch[1].trim();
        return `a:has-text("${linkText}"), a[href*="${linkText}" i], a[title*="${linkText}" i]`;
      }
      return 'a';
    } else if (command.includes('input') || command.includes('field') || command.includes('box') || command.includes('form')) {
      // Try to extract a specific field type or label
      if (command.includes('username') || command.includes('user name')) {
        return 'input[name="username"], input[id="username"], input[placeholder*="username" i], input[type="text"]';
      } else if (command.includes('password')) {
        return 'input[type="password"]';
      } else if (command.includes('email')) {
        return 'input[type="email"], input[name="email"], input[placeholder*="email" i]';
      } else if (command.includes('search')) {
        return 'input[type="search"], input[name="q"], input[placeholder*="search" i]';
      }
      return 'input, textarea';
    } else if (command.includes('checkbox')) {
      return 'input[type="checkbox"]';
    } else if (command.includes('radio')) {
      return 'input[type="radio"]';
    } else if (command.includes('dropdown') || command.includes('select')) {
      return 'select';
    } else if (command.includes('submit')) {
      return 'button[type="submit"], input[type="submit"]';
    } else if (command.includes('image')) {
      return 'img';
    } else if (command.includes('video')) {
      return 'video';
    }
    
    return null;
  }

  /**
   * Extract selector and text from command
   * @param {string} command - Text command
   * @returns {object} Object with selector and text properties
   */
  extractSelectorAndText(command) {
    // Extract text to type - multiple patterns
    let text = null;
    
    // Pattern 1: "type 'text' in ..."
    let textMatch = command.match(/(?:type|enter|input|fill|write)\s+['"]([^'"]+)['"]\s+(?:in|into|to|on)/i);
    
    // Pattern 2: "... in the field with 'text'"
    if (!textMatch) {
      textMatch = command.match(/(?:in|into|to|on).*?(?:with|containing)\s+['"]([^'"]+)['"]$/i);
    }
    
    // Pattern 3: "type 'text'"
    if (!textMatch) {
      textMatch = command.match(/(?:type|enter|input|fill|write)\s+['"]([^'"]+)['"]$/i);
    }
    
    // Pattern 4: "... with 'text'"
    if (!textMatch) {
      textMatch = command.match(/(?:with|containing)\s+['"]([^'"]+)['"]$/i);
    }
    
    // Pattern 5: content after key words without quotes
    if (!textMatch) {
      textMatch = command.match(/(?:type|enter|input|fill|write)\s+(?!in|into|to|on)([^'"]+?)(?:\s+in|\s+into|\s+on|\s*$)/i);
    }
    
    if (textMatch) {
      text = textMatch[1].trim();
    }
    
    // Now extract selector - where to type the text
    let selector = null;
    
    // Look for mentions of specific form elements
    if (command.includes('email') || command.includes('email field') || command.includes('email box')) {
      selector = 'input[type="email"], input[name="email"], input[placeholder*="email" i]';
    } else if (command.includes('password') || command.includes('password field')) {
      selector = 'input[type="password"]';
    } else if (command.includes('search') || command.includes('search box') || command.includes('search field')) {
      selector = 'input[type="search"], input[name="q"], input[placeholder*="search" i], [aria-label*="search" i]';
    } else if (command.includes('username') || command.includes('user name')) {
      selector = 'input[name="username"], input[id="username"], input[placeholder*="username" i], input[name="user"]';
    } else if (command.includes('comment') || command.includes('message')) {
      selector = 'textarea, .comment-box, [name="comment"]';
    } else if (command.includes('field') || command.includes('box') || command.includes('input')) {
      // Generic input field - less specific
      selector = 'input:visible, textarea:visible';
    }
    
    return { selector, text };
  }

  /**
   * Extract search query from command
   * @param {string} command - Text command
   * @returns {string|null} Extracted search query or null
   */
  extractSearchQuery(command) {
    // Pattern 1: "search for 'query'"
    let queryMatch = command.match(/(?:search|find|look for|query)(?:\s+for)?\s+['"]([^'"]+)['"]?/i);
    
    // Pattern 2: "search for query" (without quotes)
    if (!queryMatch) {
      queryMatch = command.match(/(?:search|find|look for|query)(?:\s+for)?\s+(.+)$/i);
    }
    
    return queryMatch ? queryMatch[1].trim() : null;
  }
}

module.exports = CommandParser;