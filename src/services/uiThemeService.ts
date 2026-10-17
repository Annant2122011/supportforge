import { getGuildConfig, type GuildTheme } from './configService';

export interface UIThemeDefinition {
  id: GuildTheme;
  label: string;
  description: string;
  color: number;
  preview: string;
}

/** Theme accents for Discord embeds; native Discord modals/buttons cannot use custom CSS. */
export const UI_THEMES: readonly UIThemeDefinition[] = [
  { id: 'midnight', label: 'Midnight Indigo', description: 'A clean, professional indigo accent.', color: 0x5865f2, preview: 'Indigo · balanced contrast' },
  { id: 'cyber-neon', label: 'Cyber Neon', description: 'Electric cyan for a futuristic support space.', color: 0x00d9ff, preview: 'Neon cyan · cyber-tech' },
  { id: 'ocean', label: 'Deep Ocean', description: 'Teal-blue accents for a focused control room.', color: 0x168aad, preview: 'Teal blue · calm and precise' },
  { id: 'aurora', label: 'Aurora Violet', description: 'Violet accents with a refined creative feel.', color: 0x8b5cf6, preview: 'Violet · expressive and polished' },
  { id: 'ember', label: 'Ember Orange', description: 'Warm orange accents with high visibility.', color: 0xf97316, preview: 'Ember orange · warm and bold' },
  { id: 'forest', label: 'Forest Green', description: 'Green accents for a reassuring support experience.', color: 0x22a06b, preview: 'Green · composed and clear' },
] as const;

export function isGuildTheme(value: unknown): value is GuildTheme {
  return typeof value === 'string' && UI_THEMES.some((theme) => theme.id === value);
}

export function getThemeDefinition(theme: GuildTheme | string | null | undefined): UIThemeDefinition {
  return UI_THEMES.find((entry) => entry.id === theme) ?? UI_THEMES[0];
}

export function getThemeColor(theme: GuildTheme | string | null | undefined): number {
  return getThemeDefinition(theme).color;
}

export async function getGuildTheme(guildId: string): Promise<UIThemeDefinition> {
  const config = await getGuildConfig(guildId);
  return getThemeDefinition(config.theme);
}
