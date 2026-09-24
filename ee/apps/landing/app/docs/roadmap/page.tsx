import { RoadmapPageShell } from "../../../components/roadmap-page-shell";
import { getGithubData } from "../../../lib/github";
import { baseOpenGraph } from "../../../lib/seo";

export const metadata = {
  title: "Sofia Roadmap",
  description:
    "What Sofia supports today and what is coming next across desktop, hosted workspaces, external agents, and new surfaces.",
  alternates: {
    canonical: "/roadmap"
  },
  openGraph: {
    ...baseOpenGraph,
    title: "Sofia Roadmap | Your workspace, on every surface",
    description:
      "The roadmap for the Sofia desktop app, portable agent capabilities, hosted workspaces, and every surface where work happens.",
    url: "https://sofia.ruut.chat/roadmap"
  }
};

export default async function DocsRoadmapPage() {
  const github = await getGithubData();

  return <RoadmapPageShell stars={github.stars} />;
}
