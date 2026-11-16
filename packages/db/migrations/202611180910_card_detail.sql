-- W40 cards: a card's technical words (an error's raw text) are the owner's only; they live here, never in the
-- message block that every reader of the chat gets.
ALTER TABLE cards ADD COLUMN detail TEXT;
