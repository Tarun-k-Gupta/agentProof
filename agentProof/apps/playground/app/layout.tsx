import type { Metadata } from 'next';
import '../../shared-design/tokens.css';
import '../../shared-design/components.css';
import { body, display, mono, fontVariables } from '../../shared-design/fonts';

export const metadata: Metadata = {
  title: 'AgentProof Playground',
  description: 'Trust the agent to decide. Don’t trust it to enforce its own limits. Try it live.',
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
      <body className={`${body.className} ${display.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}
