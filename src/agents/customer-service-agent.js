/**
 * Customer Service Agent Definition
 *
 * Handles:
 * - General customer inquiries
 * - FAQ assistance
 * - Account status queries
 * - Salesforce CRM integration for customer lookup
 * - Language-aware responses (24 EU languages)
 * - Escalation rules for complex issues
 */

/**
 * Customer Service Agent Configuration
 */
export const customerServiceAgentConfig = {
  name: 'Customer Service Agent',
  description: 'Handles customer inquiries, FAQs, and account status with CRM integration',
  type: 'conversational',
  parameters: {
    // Greeting behavior
    greeting: 'Welcome! How can I help you today?',
    language_support: ['en', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'pt', 'sv', 'da', 'no', 'fi'],

    // Context awareness
    context: {
      preserve_conversation_history: true,
      max_context_length: 5,
      context_timeout_minutes: 30,
    },

    // Escalation configuration
    escalation: {
      enabled: true,
      triggers: [
        'complaint',
        'billing_dispute',
        'technical_issue',
        'urgent',
        'escalate',
        'manager',
        'supervisor',
      ],
      escalation_queue: 'tier2_support',
      max_resolution_time_minutes: 15,
    },

    // CRM Integration
    salesforce: {
      enabled: true,
      lookup_fields: ['email', 'phone', 'account_number'],
      sync_interval_seconds: 300,
    },

    // Capabilities
    capabilities: [
      'general_inquiry',
      'faq_lookup',
      'account_status',
      'password_reset',
      'order_tracking',
      'billing_info',
      'contact_info_update',
      'product_information',
      'complaint_logging',
    ],

    // Response behavior
    responses: {
      clarify_intent: 'Could you provide more details about your inquiry?',
      not_understood: 'I didn\'t quite understand that. Could you rephrase?',
      escalation_message: 'Let me connect you with a specialist who can better assist you.',
      hold_message: 'Thank you for your patience. I\'m looking that up for you.',
    },
  },
};

/**
 * FAQ Knowledge Base
 */
export const faqDatabase = [
  {
    id: 'faq_001',
    question: 'How do I reset my password?',
    answer: 'You can reset your password by clicking "Forgot Password" on the login page. You\'ll receive an email with reset instructions.',
    category: 'account',
    languages: ['en', 'de', 'fr'],
  },
  {
    id: 'faq_002',
    question: 'What is your return policy?',
    answer: 'We offer a 30-day return policy for most items. Products must be in original condition with all packaging.',
    category: 'orders',
    languages: ['en', 'de', 'fr'],
  },
  {
    id: 'faq_003',
    question: 'How long does shipping take?',
    answer: 'Standard shipping takes 5-7 business days. Express shipping takes 2-3 business days.',
    category: 'shipping',
    languages: ['en', 'de', 'fr'],
  },
  {
    id: 'faq_004',
    question: 'How can I track my order?',
    answer: 'You can track your order using the tracking number sent to your email, or by logging into your account and viewing order history.',
    category: 'orders',
    languages: ['en', 'de', 'fr'],
  },
  {
    id: 'faq_005',
    question: 'Do you offer international shipping?',
    answer: 'Yes, we ship to most countries in Europe. Shipping costs and times vary by location.',
    category: 'shipping',
    languages: ['en', 'de', 'fr'],
  },
];

/**
 * Intent Classification Rules
 * Used to route customer inquiries appropriately
 */
export const intentClassificationRules = [
  {
    intent: 'general_inquiry',
    keywords: ['help', 'can you', 'how do', 'what is', 'tell me'],
    escalate: false,
  },
  {
    intent: 'account_access',
    keywords: ['password', 'login', 'access', 'reset', 'forgot'],
    escalate: false,
  },
  {
    intent: 'order_status',
    keywords: ['order', 'tracking', 'shipment', 'delivery', 'track'],
    escalate: false,
  },
  {
    intent: 'billing',
    keywords: ['charge', 'payment', 'invoice', 'bill', 'pricing', 'cost'],
    escalate: false,
  },
  {
    intent: 'complaint',
    keywords: ['problem', 'issue', 'complaint', 'broken', 'damaged', 'defective'],
    escalate: true,
  },
  {
    intent: 'billing_dispute',
    keywords: ['wrong charge', 'disputed', 'disputed charge', 'refund', 'overcharged'],
    escalate: true,
  },
  {
    intent: 'technical_issue',
    keywords: ['bug', 'error', 'crash', 'not working', 'technical'],
    escalate: true,
  },
  {
    intent: 'feedback',
    keywords: ['feedback', 'suggestion', 'improvement', 'idea'],
    escalate: false,
  },
];

/**
 * Classify customer intent from message
 *
 * @param {string} message - Customer message
 * @returns {Object} Classified intent with confidence score
 */
export function classifyIntent(message) {
  const lowerMessage = message.toLowerCase();
  const scores = {};

  // Score each intent based on keyword matches
  for (const rule of intentClassificationRules) {
    let matchCount = 0;
    for (const keyword of rule.keywords) {
      if (lowerMessage.includes(keyword)) {
        matchCount++;
      }
    }
    if (matchCount > 0) {
      scores[rule.intent] = matchCount;
    }
  }

  // Find highest scoring intent
  let topIntent = 'general_inquiry';
  let topScore = 0;

  for (const [intent, score] of Object.entries(scores)) {
    if (score > topScore) {
      topScore = score;
      topIntent = intent;
    }
  }

  const rule = intentClassificationRules.find(r => r.intent === topIntent);

  return {
    intent: topIntent,
    confidence: Math.min(topScore / 3, 1), // Normalize to 0-1
    shouldEscalate: rule?.escalate || false,
  };
}

/**
 * Search FAQ database for relevant answers
 *
 * @param {string} query - Search query
 * @param {string} language - Language code
 * @returns {Array} Matching FAQ entries
 */
export function searchFAQ(query, language = 'en') {
  const queryLower = query.toLowerCase();
  return faqDatabase.filter(faq => {
    const questionMatch = faq.question.toLowerCase().includes(queryLower);
    const answerMatch = faq.answer.toLowerCase().includes(queryLower);
    const languageMatch = faq.languages.includes(language);

    return (questionMatch || answerMatch) && languageMatch;
  });
}

/**
 * Build agent context from customer data
 *
 * @param {Object} customerData - Customer information from CRM
 * @returns {Object} Context object for agent
 */
export function buildAgentContext(customerData = {}) {
  return {
    customer: {
      id: customerData.id || null,
      name: customerData.name || 'Valued Customer',
      email: customerData.email || null,
      phone: customerData.phone || null,
      account_status: customerData.account_status || 'active',
      customer_since: customerData.customer_since || null,
      lifetime_value: customerData.lifetime_value || 0,
    },
    conversation: {
      start_time: new Date().toISOString(),
      language: customerData.language || 'en',
      intent: null,
      messages: [],
    },
    escalation: {
      triggered: false,
      reason: null,
      assigned_to: null,
    },
  };
}

/**
 * Generate response based on customer intent and context
 *
 * @param {string} intent - Classified intent
 * @param {Object} context - Conversation context
 * @param {string} customerMessage - Original customer message
 * @returns {Promise<string>} Generated response
 */
export async function generateResponse(intent, context, customerMessage) {
  const { language } = context.conversation;

  // Check for FAQ match first
  if (intent === 'general_inquiry' || intent === 'account_access' || intent === 'order_status') {
    const faqMatches = searchFAQ(customerMessage, language);
    if (faqMatches.length > 0) {
      return faqMatches[0].answer;
    }
  }

  // Default responses
  const responses = {
    en: {
      general_inquiry: 'I\'d be happy to help! Could you provide more details about what you need?',
      account_access: 'For account access issues, I can help you reset your password. Would you like me to guide you through that?',
      order_status: 'I can help you track your order. Please provide your order number or email address.',
      billing: 'I can assist with billing inquiries. What specific billing question do you have?',
      complaint: 'I\'m sorry to hear you\'re experiencing an issue. Let me help resolve this for you.',
      technical_issue: 'I understand you\'re experiencing a technical issue. Let me escalate this to our technical team.',
      feedback: 'Thank you for your feedback! We appreciate your suggestions for improvement.',
      default: 'I understand. How can I best assist you with that?',
    },
    de: {
      general_inquiry: 'Ich helfe Ihnen gerne! Können Sie mir mehr Details zu Ihrem Anliegen geben?',
      account_access: 'Bei Kontenzugriffsproblemen kann ich Ihnen beim Zurücksetzen des Passworts helfen.',
      order_status: 'Ich kann Ihnen beim Verfolgung Ihrer Bestellung helfen. Bitte geben Sie Ihre Bestellnummer an.',
      billing: 'Ich kann bei Abrechnungsfragen helfen. Welche Frage haben Sie zur Abrechnung?',
      complaint: 'Es tut mir leid, dass Sie ein Problem haben. Lassen Sie mich Ihnen helfen, das zu beheben.',
      technical_issue: 'Ich verstehe, dass Sie ein technisches Problem haben. Ich eskaliere das an unser technisches Team.',
      feedback: 'Vielen Dank für Ihr Feedback! Wir schätzen Ihre Verbesserungsvorschläge.',
      default: 'Ich verstehe. Wie kann ich Ihnen dabei helfen?',
    },
  };

  const langResponses = responses[language] || responses.en;
  return langResponses[intent] || langResponses.default;
}

export default {
  customerServiceAgentConfig,
  faqDatabase,
  intentClassificationRules,
  classifyIntent,
  searchFAQ,
  buildAgentContext,
  generateResponse,
};
