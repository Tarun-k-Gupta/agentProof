import { Bricolage_Grotesque, Geist, Geist_Mono } from 'next/font/google';

/**
 * Console type system.
 *
 * Deliberately not the shared-design stack (Manrope/Inter/JetBrains). Inter is
 * the default face of every dashboard on the internet and reads as "unstyled";
 * this surface has to convince a non-expert that a security claim is serious,
 * and that starts with type that looks chosen.
 *
 * Bricolage Grotesque — display. Variable, high-contrast, slightly editorial.
 * Geist — body. Clean and modern without Inter's ubiquity.
 * Geist Mono — every address, hash and number, tabular.
 */

export const display = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['500', '600', '700', '800'],
  variable: '--font-display',
  display: 'swap',
});

export const body = Geist({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-body',
  display: 'swap',
});

export const mono = Geist_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

export const fontVariables = `${display.variable} ${body.variable} ${mono.variable}`;
