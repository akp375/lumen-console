import type { Metadata } from "next";
import { WorkspaceChat } from "@/components/WorkspaceChat";
import { PAGES, tabTitle } from "@/lib/pages";

export const metadata: Metadata = { title: tabTitle(PAGES.workspace.title) };

// Fills the window below the banner and nav (about 6rem), so the input stays pinned at the bottom.
export default function WorkspacePage() {
  return (
    <main className="mx-auto flex h-[calc(100dvh-6rem)] w-full max-w-4xl flex-col px-4 py-4 sm:px-6">
      <WorkspaceChat />
    </main>
  );
}
