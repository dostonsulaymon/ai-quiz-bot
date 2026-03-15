export type AIProviderType = "claude" | "gemini" | "ollama";

export type QuestionType = "mcq" | "truefalse" | "short" | "fill";

export const DEFAULT_QUESTION_TYPES: QuestionType[] = ["mcq", "truefalse", "short", "fill"];

export type TestSourceType = "pdf" | "images" | "text";

export type TestSessionStatus = "in_progress" | "completed" | "abandoned";

export type GenerateQuestionsInput =
  | {
      content: {
        type: "text";
        text: string;
      };
      questionCount: number;
      questionTypes: QuestionType[];
    }
  | {
      content: {
        type: "pdf";
        base64: string;
      };
      questionCount: number;
      questionTypes: QuestionType[];
    }
  | {
      content: {
        type: "images";
        // Each entry carries its own MIME type so providers can send the correct media_type header.
        images: Array<{ base64: string; mimeType: string }>;
      };
      questionCount: number;
      questionTypes: QuestionType[];
    };

export type Question = {
  id: string;
  type: QuestionType;
  question: string;
  options?: {
    A: string;
    B: string;
    C: string;
    D: string;
  };
  correctAnswer: string;
  explanation?: string;
};

export type QuestionAnswer = {
  questionId: string;
  userAnswer: string;
  isCorrect: boolean;
  selfGraded?: boolean;
};
