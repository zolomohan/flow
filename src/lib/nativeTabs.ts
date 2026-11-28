/**
 * The phone's tab bar when UIKit draws it.
 *
 * On iOS the bar is a real `UITabBar` laid over the bottom of the web view
 * (`src-tauri/plugins/native-tabs`), which is what lets iOS 26 draw it in
 * Liquid Glass. This file is the page's half: putting it up, telling it which
 * tab is lit, and getting it out of the way of a sheet. Anywhere else the
 * plugin answers nothing, `showNativeTabs` resolves to null, and the page
 * draws its own bar as before.
 */
import { addPluginListener, invoke } from '@tauri-apps/api/core';
import { isDesktop } from './api';

const PLUGIN = 'native-tabs';

/** The routes that have a tab. Everything else lives in the drawer. */
export type NativeTab = 'overview' | 'transactions' | 'siri' | 'ask';
export const NATIVE_TAB_ROUTES = new Set<string>(['overview', 'transactions', 'siri', 'ask']);

const onIOS = isDesktop && /iPhone|iPad|iPod/.test(navigator.userAgent);

let shown: Promise<number | null> | null = null;
let active = false;

/** Puts the bar up. Resolves to the height it covers, or null if there is none. */
export function showNativeTabs(): Promise<number | null> {
  if (!onIOS) return Promise.resolve(null);
  shown ??= invoke<{ height: number }>(`plugin:${PLUGIN}|show`)
    .then((r) => {
      active = true;
      return r.height;
    })
    .catch(() => null);
  return shown;
}

export function onNativeTab(handler: (tab: NativeTab) => void) {
  return addPluginListener<{ id: NativeTab }>(PLUGIN, 'select', (e) => handler(e.id));
}

/** The add button beside the bar. */
export function onNativeAdd(handler: () => void) {
  return addPluginListener(PLUGIN, 'add', () => handler());
}

/** Lights a tab, or none when the page is one the drawer holds. */
export function selectNativeTab(tab: NativeTab | 'none') {
  if (!active) return;
  invoke(`plugin:${PLUGIN}|set_selected`, { id: tab }).catch(() => {});
}

export function badgeNativeTab(tab: NativeTab, count: number) {
  if (!active) return;
  const value = count > 0 ? (count > 99 ? '99+' : String(count)) : null;
  invoke(`plugin:${PLUGIN}|set_badge`, { id: tab, value }).catch(() => {});
}

/* A sheet covers the whole screen, but the bar sits above the web view, so
   it would be drawn over the sheet's foot. Every open sheet holds it down;
   the last to close lets it back up. */
let sheets = 0;
export function holdNativeTabs(open: boolean) {
  sheets = Math.max(0, sheets + (open ? 1 : -1));
  if (!active) return;
  invoke(`plugin:${PLUGIN}|set_hidden`, { hidden: sheets > 0 }).catch(() => {});
}
