export type TranslationSource = 'legge' | 'wilhelm_de' | 'hatcher' | string;

export interface LineText {
  number: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  imageCommentary?: string; // Xiang Zhuan for this line
}

export interface HexagramTranslation {
  source: TranslationSource;
  name: string;           // e.g. "The Abysmal"
  judgment: string;       // Tuan text
  judgmentCommentary?: string;  // Tuan Zhuan
  image: string;          // Xiang text
  lines: LineText[];      // Always exactly 6
  useOfNine?: string;     // Only for hexagram 1
  useOfSix?: string;      // Only for hexagram 2
}

export interface Hexagram {
  number: number;         // 1–64, King Wen sequence
  binary: string;         // e.g. "010010" bottom-to-top
  chineseName: string;    // e.g. "坎"
  pinyin: string;         // e.g. "kǎn"
  character: string;      // Hexagram Unicode symbol e.g. "䷜"
  upperTrigram: number;   // Trigram number 1–8
  lowerTrigram: number;
  translations: HexagramTranslation[];
}

export interface HexagramDatabase {
  version: string;
  sources: TranslationSource[];
  hexagrams: Hexagram[];
}
