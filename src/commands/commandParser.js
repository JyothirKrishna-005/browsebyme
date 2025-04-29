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
        'click', 'press', 'select', 'choose', 'tap'
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
          const confidence = pattern.length / command.length;
          
          if (confidence > highestConfidence) {
            highestConfidence = confidence;
            detectedIntent = intent;
          }
        }
      }
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
      
      default:
        throw new Error(`Unknown command intent: ${intent.type}`);
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
    
    // Ensure URL has protocol
    if (url && !url.startsWith('http')) {
      url = 'https://' + url;
    }
    
    if (!url) {
      throw new Error('No URL found in command');
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
    // Extract selector from command
    const selector = this.extractSelector(command);
    
    if (!selector) {
      throw new Error('No element selector found in command');
    }
    
    // Check if we have an active session
    if (!this.activeSession) {
      throw new Error('No active browser session');
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
    // Extract selector and text
    const { selector, text } = this.extractSelectorAndText(command);
    
    if (!selector || !text) {
      throw new Error('Missing selector or text in command');
    }
    
    // Check if we have an active session
    if (!this.activeSession) {
      throw new Error('No active browser session');
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
      throw new Error('No search query found in command');
    }
    
    // Check if we have an active session, create one if not
    if (!this.activeSession) {
      const session = await this.browserController.launchBrowser();
      this.activeSession = session.sessionId;
    }
    
    // Navigate to Google and perform search
    await this.browserController.navigateTo('https://www.google.com', this.activeSession);
    await this.browserController.fillField('input[name="q"]', query, this.activeSession);
    await this.browserController.clickElement('input[name="btnK"], input[type="submit"]', this.activeSession);
    
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
    // Extract booking details using NLP
    const entities = extractEntities(command);
    
    return {
      action: 'book',
      entities,
      message: 'Booking task initialized',
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
   * Extract URL from command
   * @param {string} command - Text command
   * @returns {string|null} Extracted URL or null
   */
  extractUrl(command) {
    // Simple regex to extract URLs
    const urlPattern = /(?:go to|open|visit|navigate to|browse)\s+(?:https?:\/\/)?([a-zA-Z0-9][-a-zA-Z0-9]*\.)?[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}(?:\/[-a-zA-Z0-9:%_\+.~#?&//=]*)?/i;
    const match = command.match(urlPattern);
    
    if (match) {
      // Extract the domain part
      const urlPart = match[0].split(/\s+/).slice(-1)[0];
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
      return 'button, input[type="button"], input[type="submit"], [role="button"]';
    } else if (command.includes('search box')) {
      return 'input[type="search"], input[name="q"]';
    } else if (command.includes('link')) {
      // Extract link text
      const linkTextMatch = command.match(/link\s+(?:with text|that says|saying|containing)\s+"([^"]+)"/i);
      if (linkTextMatch) {
        return `a:has-text("${linkTextMatch[1]}")`;
      }
      return 'a';
    } else if (command.includes('input') || command.includes('field')) {
      return 'input, textarea';
    }
    
    return null;
  }

  /**
   * Extract selector and text from command
   * @param {string} command - Text command
   * @returns {object} Object with selector and text properties
   */
  extractSelectorAndText(command) {
    // Try to determine selector
    let selector = null;
    
    if (command.includes('email')) {
      selector = 'input[type="email"], input[name="email"]';
    } else if (command.includes('password')) {
      selector = 'input[type="password"]';
    } else if (command.includes('search')) {
      selector = 'input[type="search"], input[name="q"]';
    } else if (command.includes('username')) {
      selector = 'input[name="username"], input[id="username"]';
    } else {
      selector = 'input, textarea';
    }
    
    // Extract text to type
    const textMatch = command.match(/(?:type|enter|input|fill|write)\s+"([^"]+)"/i);
    const text = textMatch ? textMatch[1] : null;
    
    return { selector, text };
  }

  /**
   * Extract search query from command
   * @param {string} command - Text command
   * @returns {string|null} Extracted search query or null
   */
  extractSearchQuery(command) {
    const queryMatch = command.match(/(?:search|find|look for|query)\s+(?:for\s+)?["']?([^"']+)["']?/i);
    return queryMatch ? queryMatch[1].trim() : null;
  }
}

module.exports = CommandParser; 