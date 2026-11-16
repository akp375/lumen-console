import type { Metadata } from "next";
import { WorkspaceChat } from "@/components/WorkspaceChat";

export const metadata: Metadata = { title: "Workspace · Cockpit · Lumen AI" };

// Fills the window below the banner and nav (about 6rem), so the input stays pinned at the bottom.
export default function WorkspacePage() {
  return (
    <main className="mx-auto flex h-[calc(100dvh-6rem)] w-full max-w-4xl flex-col px-4 py-4 sm:px-6">
      <WorkspaceChat />
    </main>
  );
}
