import { LandingHome } from "../components/landing-home";
import { getGithubData } from "../lib/github";
import { headers } from "next/headers";
import { StructuredData } from "../components/structured-data";
import { homeFaq } from "../lib/faq";
import { baseOpenGraph } from "../lib/seo";

export const metadata = {
  title: "Sofia — Your work. Your tools. Meet Sofia.",
  description: "Work with Sofia on your files, research, and everyday tasks. Choose your model, connect your tools, and bring your team along.",
  alternates: {
    canonical: "/"
  },
  openGraph: {
    ...baseOpenGraph,
    title: "Sofia — Your work. Your tools. Meet Sofia.",
    description: "Work with Sofia on your files, research, and everyday tasks. Choose your model, connect your tools, and bring your team along.",
    url: "https://sofia.ruut.chat"
  }
};

const softwareApplicationSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Sofia",
  description:
    "Sofia is a desktop app for working with AI on your files, research, and everyday tasks, with a choice of model providers and shared tools for teams.",
  url: "https://sofia.ruut.chat",
  applicationCategory: "BusinessApplication",
  operatingSystem: "macOS, Windows, Linux",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
    url: "https://sofia.ruut.chat/pricing"
  },
  publisher: {
    "@type": "Organization",
    name: "Sofia",
    url: "https://sofia.ruut.chat"
  }
};

const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: homeFaq.map((entry) => ({
    "@type": "Question",
    name: entry.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: entry.answer
    }
  }))
};

export default async function Home() {
  const github = await getGithubData();
  const cal = process.env.NEXT_PUBLIC_CAL_URL || "/enterprise#book";
  const userAgent = (await headers()).get("user-agent")?.toLowerCase() || "";
  const isMobileVisitor = /android|iphone|ipad|ipod|mobile/.test(userAgent);

  return (
    <>
      <StructuredData data={softwareApplicationSchema} />
      <StructuredData data={faqSchema} />
      <LandingHome
        stars={github.stars}
        downloadHref={github.downloads.macos}
        windowsDownloadHref={github.downloads.windows}
        linuxDownloadHref={github.downloads.linux}
        callHref={cal}
        isMobileVisitor={isMobileVisitor}
      />
    </>
  );
}
