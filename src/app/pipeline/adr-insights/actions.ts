"use server";

import { generateAdrMemo } from "@/lib/adr-memo";
import type { AdrMemo } from "@/lib/adr-memo-shared";
import { ClaudeLimitError } from "@/lib/claude";

/** Generates a new ADR memo (one paid Claude call) and saves it. */
export async function generateAdrMemoAction(): Promise<{ memo?: AdrMemo; saveError?: string | null; notice?: string; error?: string }> {
  try {
    return await generateAdrMemo();
  } catch (e) {
    if (e instanceof ClaudeLimitError) return { notice: e.message };
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
