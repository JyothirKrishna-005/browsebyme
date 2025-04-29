# BrowseByMe

An AI-powered web browser automation tool that allows you to control browsers using simple text commands.

## 🛠 Features

- 👉 **Full Browser Automation** – From shopping to ticket booking to research, BrowseByMe handles it all
- 👉 **Text Commands** – Simply tell it what you want, and BrowseByMe gets it done
- 👉 **Smart Form Filling** – Automatically enters details like addresses, payment info (securely)
- 👉 **Task Understanding** – Understands complex tasks like "Book 2 tickets for Avengers at 7 PM tomorrow"
- 👉 **Multi-Tasking** – Search products, fill forms, and book tickets simultaneously
- 👉 **Secure Browsing** – Prioritizes your privacy, no sensitive data stored
- 👉 **Seamless Integration** – Works with popular browsers like Chrome, Edge, Firefox, and Safari
- 👉 **Google Gemini AI** – Enhanced command understanding with Google's Gemini AI

## 📋 Prerequisites

- Node.js (v14 or newer)
- npm or yarn
- Supported browsers (Chrome, Firefox, Safari, or Edge)
- [Optional] Google Gemini API key for enhanced AI features

## 🚀 Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/browsebyme.git
cd browsebyme
```

2. Install dependencies:
```bash
npm install
```

3. Create a .env file with the following configuration:
```
PORT=3000
NODE_ENV=development
LOG_LEVEL=info
GEMINI_API_KEY=your_api_key_here  # Optional but recommended
```

4. Create the logs directory:
```bash
mkdir logs
```

## 💻 Usage

Start the application:
```bash
npm start
```

### Example Commands

You can interact with BrowseByMe by sending HTTP POST requests to the `/command` endpoint with a JSON body containing the command:

```json
{
  "command": "open chrome and go to amazon.com"
}
```

Here are some example commands:

- "Open Firefox and go to google.com"
- "Search for best laptops under $1000"
- "Click on the first search result"
- "Fill the email field with 'user@example.com'"
- "Book 2 tickets for Avatar at 7 PM tomorrow"
- "Buy MacBook Pro from bestbuy.com"
- "Close all browsers"

## 🧠 AI-Powered Features

BrowseByMe can be enhanced with Google's Gemini AI for better command understanding:

1. Get a Gemini API key from https://makersuite.google.com/app/apikey
2. Add the API key to your .env file: `GEMINI_API_KEY=your_api_key_here`
3. Restart the application

With Gemini AI integration enabled, BrowseByMe will:
- Better understand complex commands
- Generate more accurate selectors for web elements
- Adapt to different website structures
- Provide more natural language interaction

## 🔧 Development

Run in development mode with hot reloading:
```bash
npm run dev
```

Run tests:
```bash
npm test
```

## 🛡️ Security

BrowseByMe prioritizes security and privacy:

- No sensitive data is stored
- Browser sessions are isolated
- All commands are logged for transparency
- Password fields are handled securely

## 📚 Architecture

BrowseByMe consists of the following main components:

- **Browser Controller**: Manages browser instances and provides automation methods
- **Command Parser**: Interprets text commands and calls appropriate browser actions
- **NLP Helper**: Provides natural language processing functions for entity extraction
- **Gemini AI Service**: Integrates with Google's Generative AI for enhanced command understanding
- **Logger**: Handles logging for debugging and auditing

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 👥 Contributing

Contributions are welcome! Please feel free to submit a Pull Request. 