"use client";

import { createContext, useContext } from "react";
import { DEFAULT_VOCABULARY, wordsFor, type VocabularyId, type Words } from "@/data/vocabulary";

/**
 * The words this workspace uses for its own work, for every screen under the
 * app shell.
 *
 * Read once on the server by the layout that wraps every page and handed down,
 * the same shape as `CurrencyProvider` and for the same reason: a board three
 * levels deep should ask what a stage is called rather than every screen
 * threading the answer through its children. That is exactly how a hard-coded
 * "$" reached two dozen files before the currency work.
 *
 * The default is the sales set, which is what every workspace read before this
 * existed — so a component rendered outside the shell shows what it always did
 * rather than nothing.
 */
const VocabularyContext = createContext<VocabularyId>(DEFAULT_VOCABULARY);

export function VocabularyProvider({
  vocabulary,
  children,
}: {
  vocabulary: VocabularyId;
  children: React.ReactNode;
}) {
  return <VocabularyContext.Provider value={vocabulary}>{children}</VocabularyContext.Provider>;
}

/** The chosen set's id — pass it to `stageMeta` or `boardStages`. */
export function useVocabulary(): VocabularyId {
  return useContext(VocabularyContext);
}

/** The words themselves: `words.one` is "Deal" or "Job". */
export function useWords(): Words {
  return wordsFor(useContext(VocabularyContext));
}
