'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  isHandsetWidth, loadConsolePreference, saveConsolePreference,
} from '@/lib/fieldOperator';

/**
 * Sends a handset to field mode the first time it arrives.
 *
 * Renders nothing. A phone gets the three-button view by default because
 * that is what a phone in this environment is for — but it is a default,
 * not a cage: /field carries a "Full console" link that records the choice,
 * and the choice sticks. Trapping every narrow viewport in three buttons
 * would make the roster unreachable to someone who needs it on a phone,
 * which is a worse failure than a desk user seeing one extra tap.
 *
 * Only on first arrival at the dashboard. Redirecting from any page would
 * mean a link someone sent to /cargo silently went somewhere else.
 */
export function FieldModeGate() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (pathname !== '/') return;
    if (loadConsolePreference() !== null) return;
    if (!isHandsetWidth()) return;
    saveConsolePreference('field');
    router.replace('/field');
  }, [pathname, router]);

  return null;
}
