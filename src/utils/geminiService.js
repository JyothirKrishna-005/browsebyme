/**
 * Gemini AI Service
 * Integrates with Google's Gemini API for AI-powered browser control
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { logger } = require('./logger');
const fs = require('fs').promises;
const path = require('path');

class GeminiService {
  constructor(apiKey) {
    // Initialize Gemini API client
    this.apiKey = apiKey;
    
    if (!this.apiKey) {
      logger.warn('No Gemini API key provided. AI features will be disabled.');
    } else {
      this.genAI = new GoogleGenerativeAI(this.apiKey);
      logger.info('Gemini AI service initialized');
    }
    
    // Store conversation history for context
    this.history = [];
    
    // Load system instructions
    this.loadSystemInstructions();
  }
  
  /**
   * Load system instructions for the AI model
   */
  async loadSystemInstructions() {
    try {
      const instructionsPath = path.join(__dirname, '../config/ai-instructions.txt');
      this.systemInstructions = await fs.readFile(instructionsPath, 'utf-8');
      logger.info('Loaded AI system instructions');
    } catch (error) {
      this.systemInstructions = 
        "You are BrowseByMe AI, a browser automation assistant. " +
        "Your task is to understand user commands about web browsing and convert them to specific " +
        "structured actions the system can perform. Focus on tasks like navigation, clicking, form filling, " +
        "and searching. Be specific and precise in your instructions.";
      
      logger.warn(`Failed to load AI instructions: ${error.message}. Using default instructions.`);
    }
  }
  
  /**
   * Process a user command with Gemini AI
   * @param {string} userCommand - User's text command
   * @param {object} currentState - Current browser state
   * @returns {object} Structured command object
   */
  async processCommand(userCommand, currentState = {}) {
    // If no API key, return a simple fallback processing
    if (!this.apiKey || !this.genAI) {
      logger.warn('No Gemini API key - using fallback command processing');
      return this.fallbackProcessCommand(userCommand);
    }

    try {
      // Update conversation history
      this.addToHistory("user", userCommand);
      
      // Prepare context about the current browser state
      const stateInfo = this.formatStateInfo(currentState);
      
      // Create the model
      const model = this.genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
      
      // Create chat session
      const chat = model.startChat({
        history: this.prepareChatHistory(),
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1500,
        }
      });
      
      // Format prompt with context and example of DOM structure if available
      const domInfo = currentState.domSnapshot ? 
        `\nCurrent page DOM structure (partial):\n${currentState.domSnapshot}` : '';
      
      const prompt = `
        ${this.systemInstructions}
        
        Current browser state:
        ${stateInfo}
        ${domInfo}
        
        Analyze the following user request: "${userCommand}"
        
        1. Identify the primary task the user wants to accomplish
        2. Determine the sequence of actions needed
        3. For each action, provide all necessary details (selectors, values, etc.)
        4. Remember to use only standard CSS selectors, not jQuery-style selectors
        
        Respond with a structured JSON action plan that can be executed by the system.
        The response should be a single action object or an array of action objects if multiple steps are needed.
        Each action object should include appropriate fields like "action", "selector", "value", etc.
        
        Return ONLY the JSON response without any other text, explanations, or formatting.
      `;
      
      // Send to model
      const result = await chat.sendMessage(prompt);
      const responseText = result.response.text();
      
      // Extract JSON from response (in case model adds extra text)
      const jsonMatch = responseText.match(/(\[|\{)[\s\S]*(\]|\})/);
      let parsedResult;
      
      if (jsonMatch) {
        try {
          parsedResult = JSON.parse(jsonMatch[0]);
          logger.info(`AI processed command: ${JSON.stringify(parsedResult)}`);
          
          // Clean up any invalid selectors in the result
          parsedResult = this.sanitizeSelectors(parsedResult);
          
          // Add to history
          this.addToHistory("assistant", JSON.stringify(parsedResult));
          
          return parsedResult;
        } catch (parseError) {
          logger.error(`Failed to parse AI response as JSON: ${parseError.message}`);
          // Continue to fallback
        }
      }
      
      // If we get here, something went wrong with the JSON
      logger.warn(`AI response not in valid JSON format: ${responseText.substring(0, 100)}...`);
      return this.fallbackProcessCommand(userCommand);
      
    } catch (error) {
      logger.error(`Gemini AI error: ${error.message}`);
      return this.fallbackProcessCommand(userCommand);
    }
  }
  
  /**
   * Sanitize selectors to ensure they're valid CSS selectors
   * @param {object|array} result - The parsed result from AI
   * @returns {object|array} Sanitized result
   */
  sanitizeSelectors(result) {
    // Handle array of actions
    if (Array.isArray(result)) {
      return result.map(action => this.sanitizeSelectors(action));
    }
    
    // Handle single action object
    if (result && typeof result === 'object') {
      // If there's a selector field, sanitize it
      if (result.selector) {
        // Remove jQuery-style selectors
        result.selector = result.selector
          .replace(/:visible/g, '')
          .replace(/:contains\((.*?)\)/g, ':has-text($1)')
          .replace(/:eq\(\d+\)/g, '')
          .trim();
        
        // If selector became empty or too simple, provide a fallback
        if (!result.selector || result.selector === '') {
          if (result.action === 'click') {
            result.selector = 'button, a, [role="button"]';
          } else if (result.action === 'type') {
            result.selector = 'input, textarea';
          }
        }
      }
      
      // Recursively process nested objects
      for (const key in result) {
        if (typeof result[key] === 'object' && result[key] !== null) {
          result[key] = this.sanitizeSelectors(result[key]);
        }
      }
    }
    
    return result;
  }
  
  /**
   * Format the current browser state info
   * @param {object} state - Current state object
   * @returns {string} Formatted state info
   */
  formatStateInfo(state) {
    if (!state || Object.keys(state).length === 0) {
      return "No active browser session.";
    }
    
    let info = [];
    
    if (state.url) {
      info.push(`Current URL: ${state.url}`);
    }
    
    if (state.title) {
      info.push(`Page title: ${state.title}`);
    }
    
    if (state.activeSessionId) {
      info.push(`Active session ID: ${state.activeSessionId}`);
    }
    
    if (state.browserType) {
      info.push(`Browser type: ${state.browserType}`);
    }
    
    if (state.visibleElements) {
      info.push(`Notable page elements: ${state.visibleElements.join(', ')}`);
    }
    
    return info.join('\n');
  }
  
  /**
   * Fallback command processing without AI
   * @param {string} command - User command
   * @returns {object} Simple structured command
   */
  fallbackProcessCommand(command) {
    const normalizedCommand = command.toLowerCase();
    
    // Very simple rule-based parsing
    if (normalizedCommand.includes('go to') || normalizedCommand.includes('navigate')) {
      const urlMatch = normalizedCommand.match(/(?:go to|navigate to|open)\s+([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
      if (urlMatch) {
        return {
          action: 'navigate',
          url: urlMatch[1]
        };
      }
    }
    
    if (normalizedCommand.includes('click')) {
      const clickMatch = normalizedCommand.match(/click\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+button|\s+link|$)/i);
      if (clickMatch) {
        return {
          action: 'click',
          target: clickMatch[1].trim()
        };
      }
    }
    
    if (normalizedCommand.includes('type') || normalizedCommand.includes('enter') || normalizedCommand.includes('input')) {
      const typeMatch = normalizedCommand.match(/(?:type|enter|input)\s+["'](.+?)["']/i);
      if (typeMatch) {
        return {
          action: 'type',
          value: typeMatch[1],
          target: 'input field'
        };
      }
    }
    
    if (normalizedCommand.includes('search')) {
      const searchMatch = normalizedCommand.match(/search\s+(?:for\s+)?(.+)$/i);
      if (searchMatch) {
        return {
          action: 'search',
          value: searchMatch[1].trim()
        };
      }
    }
    
    // Default to treating the command as-is
    return {
      action: 'unknown',
      originalCommand: command
    };
  }
  
  /**
   * Add a message to the conversation history
   * @param {string} role - "user" or "assistant"
   * @param {string} content - Message content
   */
  addToHistory(role, content) {
    this.history.push({ role, content });
    
    // Keep history at a reasonable size
    if (this.history.length > 20) {
      this.history.shift();
    }
  }
  
  /**
   * Prepare chat history in the format expected by Gemini
   * @returns {Array} Formatted chat history
   */
  prepareChatHistory() {
    return this.history.map(entry => ({
      role: entry.role,
      parts: [{ text: entry.content }]
    }));
  }
  
  /**
   * Clear the conversation history
   */
  clearHistory() {
    this.history = [];
  }
}

module.exports = GeminiService; 