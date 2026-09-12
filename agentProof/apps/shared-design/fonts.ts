import { Manrope, Inter, JetBrains_Mono } from 'next/font/google';

/**
 * Shared AgentProof type system, served self-hosted by next/font at build
 * time — no runtime font CDN, so judges offline still see the real thing.
 *
 * Manrope = display/headings (trust, modern, not techy).
 * Inter = body/labels. JetBrains Mono = every number, tabular.
 */

export const display = Manrope({
  subsets: ['latin'],
  weight: ['600', '700', '800'],
  variable: '--font-display',
  display: 'swap',
});

export const body = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-body',
  display: 'swap',
});

export const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-mono',
  display: 'swap',
});

export const fontVariables = `${display.variable} ${body.variable} ${mono.variable}`;
