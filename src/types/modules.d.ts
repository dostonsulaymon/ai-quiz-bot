declare module "arabic-reshaper" {
  export default class ArabicReshaper {
    static convertArabic(text: string): string;
  }
}

declare module "bidi-js" {
  export default function bidiFactory(): {
    getReorderedString(text: string, embeddingLevels: any): string;
    getEmbeddingLevels(text: string): any;
  };
}
