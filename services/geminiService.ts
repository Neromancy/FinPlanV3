
import { GoogleGenAI, GenerateContentResponse, Type } from "@google/genai";
import { Category, Goal, Transaction } from '../types.ts';

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// Helper to convert file to base64
const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = error => reject(error);
    });
};


export const categorizeTransaction = async (description: string, categories: string[]): Promise<{ category: Category; confidence: number }> => {
  try {
    const prompt = `Analyze the transaction description "${description}" and categorize it into one of the following valid categories: ${categories.join(', ')}. Also, provide a confidence score between 0.0 and 1.0 for your categorization.`;

    const response = await ai.models.generateContent({
      model: 'models/gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            category: {
              type: Type.STRING,
              description: `The transaction category. Must be one of: ${categories.join(', ')}`,
            },
            confidence: {
              type: Type.NUMBER,
              description: "A value between 0 and 1 representing the model's confidence in the categorization."
            }
          },
          required: ['category', 'confidence']
        }
      }
    });

    const jsonString = response.text.trim();
    if (!jsonString) {
      console.error("No JSON found in AI response for categorization");
      return { category: 'Other', confidence: 0 };
    }

    const result = JSON.parse(jsonString);
    const category = result.category as Category;
    const confidence = result.confidence as number;
    
    if (categories.includes(category) && typeof confidence === 'number') {
        return { category, confidence };
    }
    
    return { category: 'Other', confidence: 0 };

  } catch (error) {
    console.error("Error categorizing transaction:", error);
    return { category: 'Other', confidence: 0 };
  }
};

export const scanReceipt = async (imageFile: File): Promise<{ merchant: string; total: number; date: string }> => {
    try {
        const base64Image = await fileToBase64(imageFile);
        const imagePart = {
            inlineData: {
                mimeType: imageFile.type,
                data: base64Image,
            },
        };
        const textPart = {
            text: "Extract the merchant name, total amount, and date from this receipt. The date should be in YYYY-MM-DD format."
        };

        const response: GenerateContentResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: { parts: [imagePart, textPart] },
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        merchant: { type: Type.STRING },
                        total: { type: Type.NUMBER },
                        date: { type: Type.STRING }
                    },
                    required: ['merchant', 'total', 'date']
                }
            }
        });

        const jsonString = response.text.trim();
        if (!jsonString) {
          throw new Error("Failed to extract valid JSON from receipt analysis.");
        }
        const result = JSON.parse(jsonString);
        return {
            merchant: result.merchant || '',
            total: result.total || 0,
            date: result.date || new Date().toISOString().split('T')[0],
        };
    } catch (error) {
        console.error("Error scanning receipt:", error);
        throw new Error("Failed to analyze receipt. Please try again.");
    }
};


export const suggestGoals = async (financialSummary: { income: number; expenses: number; balance: number }): Promise<Omit<Goal, 'id' | 'savedAmount' | 'isCompleted' | 'createdAt'>[]> => {
  try {
    const prompt = `A user has a monthly income of $${financialSummary.income}, expenses of $${financialSummary.expenses}, and a balance of $${financialSummary.balance}. Suggest three realistic, personalized savings goals with target amounts. Examples: "Emergency Fund", "Vacation", "New Gadget".`;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    goals: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                name: { type: Type.STRING },
                                targetAmount: { type: Type.NUMBER }
                            },
                             required: ['name', 'targetAmount']
                        }
                    }
                },
                required: ['goals']
            }
        }
    });

    const jsonString = response.text.trim();
    if (!jsonString) {
      console.error("No JSON found in AI response for goal suggestion");
      return [];
    }
    const result = JSON.parse(jsonString);
    return result.goals || [];
  } catch (error) {
    console.error("Error suggesting goals:", error);
    return [];
  }
};

export const generateBudgetPlan = async (
  goal: Goal, 
  transactions: Transaction[], 
  balance: number, 
  language: 'en' | 'id' | 'ja',
  formatCurrency: (amount: number) => string
): Promise<string> => {
  try {
    const recentTransactions = transactions
      .filter(t => t.type === 'expense')
      .slice(0, 20)
      .map(t => `${t.description}: ${formatCurrency(t.amount)} in ${t.category}`).join('\n');

    let languageInstruction = 'Generate the entire plan in English.';
    if (language === 'id') {
      languageInstruction = 'Generate the entire plan in Indonesian.';
    } else if (language === 'ja') {
      languageInstruction = 'Generate the entire plan in Japanese.';
    }

    const prompt = `
A user wants to save for "${goal.name}" with a target of ${formatCurrency(goal.targetAmount)}. They have already saved ${formatCurrency(goal.savedAmount)}.
Their current balance is ${formatCurrency(balance)}.
${languageInstruction}

Here are their 20 most recent expense transactions:
${recentTransactions}

Generate a custom budget plan in markdown format. The plan MUST be concise and consist of a summary and bullet points under bold headers. **Do not write long paragraphs.**

Follow this structure exactly:

**Summary**
* A brief, encouraging overview and a projected timeline to reach the goal.

**Spending Limits**
* A bulleted list of suggested monthly spending limits for their top 3-4 expense categories.

**Savings Tips**
* A bulleted list of 3 actionable savings tips based on their actual spending habits.

Use ONLY bullet points (*).

${goal.aiPlan ? `This is an updated plan. Their previous plan was:\n${goal.aiPlan}\nComment on their progress and adjust the new plan, keeping the same format.` : ''}
    `;
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });
    return response.text;
  } catch (error) {
    console.error("Error generating budget plan:", error);
    return "Could not generate an AI budget plan. Please try again.";
  }
};