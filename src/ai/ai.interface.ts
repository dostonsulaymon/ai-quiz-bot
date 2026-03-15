import type { GenerateQuestionsInput, Question } from "../shared/types/index.js";

export interface IAIProvider {
  generateQuestions(input: GenerateQuestionsInput): Promise<Question[]>;
}
