-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Trigrams (8 rows, from strobus.json)
-- ---------------------------------------------------------------------------
CREATE TABLE trigrams (
  number        SMALLINT PRIMARY KEY CHECK (number BETWEEN 1 AND 8),
  chinese_name  TEXT NOT NULL,
  pinyin        TEXT NOT NULL,
  character     TEXT NOT NULL,       -- Unicode symbol e.g. ☰
  trigram_binary CHAR(3) NOT NULL,   -- e.g. "111" bottom-to-top
  attribute     TEXT,
  images        TEXT[],              -- e.g. ['heaven']
  chinese_image TEXT,
  pinyin_image  TEXT,
  family_rel    TEXT                 -- e.g. "father"
);

-- ---------------------------------------------------------------------------
-- Hexagrams (64 rows)
-- ---------------------------------------------------------------------------
CREATE TABLE hexagrams (
  number        SMALLINT PRIMARY KEY CHECK (number BETWEEN 1 AND 64),
  hexagram_binary CHAR(6) NOT NULL,  -- e.g. "111111" bottom-to-top
  chinese_name  TEXT NOT NULL,
  pinyin        TEXT NOT NULL,
  character     TEXT NOT NULL,       -- Unicode symbol e.g. ䷀
  upper_trigram SMALLINT NOT NULL REFERENCES trigrams(number),
  lower_trigram SMALLINT NOT NULL REFERENCES trigrams(number)
);

-- ---------------------------------------------------------------------------
-- Translations (one row per source per hexagram)
-- ---------------------------------------------------------------------------
CREATE TABLE hexagram_translations (
  id                    SERIAL PRIMARY KEY,
  hexagram_number       SMALLINT NOT NULL REFERENCES hexagrams(number),
  source                TEXT NOT NULL,     -- 'legge', 'wilhelm_de', 'hatcher', …
  name                  TEXT NOT NULL,     -- translation's name for the hexagram
  judgment              TEXT NOT NULL,
  judgment_commentary   TEXT,
  image                 TEXT NOT NULL,
  use_of_nine           TEXT,              -- hexagram 1 only
  use_of_six            TEXT,             -- hexagram 2 only
  UNIQUE (hexagram_number, source)
);

-- ---------------------------------------------------------------------------
-- Lines (6 rows per translation = up to 384 rows per source)
-- ---------------------------------------------------------------------------
CREATE TABLE lines (
  id                      SERIAL PRIMARY KEY,
  translation_id          INTEGER NOT NULL REFERENCES hexagram_translations(id),
  line_number             SMALLINT NOT NULL CHECK (line_number BETWEEN 1 AND 6),
  text                    TEXT NOT NULL,
  image_commentary        TEXT,
  UNIQUE (translation_id, line_number)
);

-- ---------------------------------------------------------------------------
-- Corpus chunks  — the RAG layer
-- Each row is one embeddable piece of text (line, judgment, commentary, etc.)
-- ---------------------------------------------------------------------------
CREATE TABLE corpus_chunks (
  id              SERIAL PRIMARY KEY,
  hexagram_number SMALLINT REFERENCES hexagrams(number),  -- NULL for cross-cutting docs
  source          TEXT NOT NULL,
  chunk_type      TEXT NOT NULL,   -- 'judgment', 'image', 'line', 'commentary', 'ten_wings'
  line_number     SMALLINT,        -- NULL for non-line chunks
  content         TEXT NOT NULL,
  -- parent_id allows hierarchical retrieval: retrieve a line, include its judgment parent
  parent_id       INTEGER REFERENCES corpus_chunks(id),
  embedding       vector(1536)     -- OpenAI text-embedding-3-small
);

-- HNSW index for fast ANN search (better recall/speed tradeoff than IVFFlat)
CREATE INDEX corpus_chunks_embedding_hnsw
  ON corpus_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Useful for filtering by hexagram before vector search
CREATE INDEX corpus_chunks_hexagram_idx ON corpus_chunks (hexagram_number);
CREATE INDEX corpus_chunks_type_idx ON corpus_chunks (chunk_type);
