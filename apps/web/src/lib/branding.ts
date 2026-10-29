import { type BrandingSettings, DEFAULT_BRANDING_SETTINGS } from '@argus/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from './api';

/** The installation's product name and sign-in notice; also keeps the browser tab title in step. */
export function useBranding(): BrandingSettings {
  const q = useQuery({ queryKey: ['branding'], queryFn: () => api<BrandingSettings>('/settings/branding'), staleTime: 5 * 60_000 });
  const branding = q.data ?? DEFAULT_BRANDING_SETTINGS;
  useEffect(() => {
    document.title = branding.productName;
  }, [branding.productName]);
  return branding;
}
