import type { Metadata } from "next";

import { MigrationGuidePage } from "../../../../components/migration-guide-page";
import { getGithubData } from "../../../../lib/github";
import { baseOpenGraph } from "../../../../lib/seo";

export const metadata: Metadata = {
  title: "Migrate from Claude Cowork to Sofia",
  description:
    "Move your files, skills, plugins, MCP servers, scheduled tasks, and team setup from Claude Cowork to Sofia.",
  alternates: {
    canonical: "/docs/start-here/migrate-from-claude-cowork"
  },
  openGraph: {
    ...baseOpenGraph,
    title: "Migrate from Claude Cowork to Sofia",
    description:
      "A step-by-step guide to moving your Cowork setup to open-source Sofia.",
    url: "https://sofia.ruut.chat/docs/start-here/migrate-from-claude-cowork"
  }
};

export default async function MigrateFromClaudeCoworkPage() {
  const github = await getGithubData();

  return (
    <MigrationGuidePage
      stars={github.stars}
      downloadHref={github.downloads.macos}
    />
  );
}
