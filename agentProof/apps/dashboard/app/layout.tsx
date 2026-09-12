import type { Metadata, Viewport } from 'next';
import '../../shared-design/tokens.css';
import '../../shared-design/components.css';
import './globals.css';
import { body, display, mono } from '../../shared-design/fonts';

export const metadata: Metadata = {
  title: 'AgentProof',
  description: 'Trust the agent to decide. Don’t trust it to enforce its own limits.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafaf7' },
    { media: '(prefers-color-scheme: dark)', color: '#080f1d' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('agentproof-theme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t;}}catch(e){}})();`,
          }}
        />
      </head>
      <body className={`${body.className} ${display.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}
