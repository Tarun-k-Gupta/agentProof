import type { Metadata, Viewport } from 'next';
import '../../shared-design/tokens.css';
import '../../shared-design/components.css';
import './theme.css';
import './globals.css';
import { body, display, mono, fontVariables } from '@/lib/fonts';
import { Shell } from '../components/Shell';

const TAGLINE =
  'An AI is spending your money. AgentProof is the spending limit it cannot talk its way around — enforced on-chain, not by the model.';

export const metadata: Metadata = {
  title: {
    default: 'AgentProof — spending limits an AI agent cannot argue with',
    template: '%s · AgentProof',
  },
  description: TAGLINE,
  applicationName: 'AgentProof',
  keywords: [
    'AI agent security',
    'ERC-7579',
    'ERC-4337',
    'Uniswap v4',
    'ENSv2',
    'Hedera',
    'x402',
    'The Graph',
    'formal verification',
  ],
  openGraph: {
    title: 'AgentProof — spending limits an AI agent cannot argue with',
    description: TAGLINE,
    siteName: 'AgentProof',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'AgentProof',
    description: TAGLINE,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafaf7' },
    { media: '(prefers-color-scheme: dark)', color: '#080f1d' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('agentproof-theme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t;}}catch(e){}})();`,
          }}
        />
      </head>
      <body className={`${body.className} ${display.variable} ${mono.variable}`}>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
