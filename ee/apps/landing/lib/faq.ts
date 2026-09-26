export type FaqEntry = {
  question: string;
  answer: string;
};

export const homeFaq: FaqEntry[] = [
  {
    question: "What is Sofia?",
    answer:
      "Sofia is a desktop app for working with AI on your files and everyday tasks. Ask it to research a topic, work through a spreadsheet, draft a document, or help with a project. You choose the model and tools it uses."
  },
  {
    question: "Is Sofia free?",
    answer:
      "The desktop app is free. Connect your own model provider; that provider’s usage charges may apply. Cloud and enterprise services have separate plans. See the pricing page for current options."
  },
  {
    question: "Can I use Sofia with my team?",
    answer:
      "Yes. Sofia Cloud lets your organization manage model access, share skills and plugins, and connect tools for your team. Administrators can assign access and set policies so people have the resources they need."
  },
  {
    question: "Which AI models does Sofia support?",
    answer:
      "Sofia supports providers including OpenAI, Anthropic, Google, OpenRouter, and Mistral. Connect your own provider or use one made available by your organization. Available models and capabilities depend on the provider you choose."
  },
  {
    question: "Where does my work happen?",
    answer:
      "The desktop app works with files on your computer. Prompts and relevant file content may be sent to your selected model provider or connected tools to complete a task. Cloud workspaces run remotely. Where data is processed depends on your workspace, provider, and connections."
  },
  {
    question: "Do I need to be technical to use Sofia?",
    answer:
      "You can describe tasks in plain language and review the results in the app. To get started, connect a model provider and choose a project folder. Your organization can also provide models, skills, and tools for you."
  }
];
