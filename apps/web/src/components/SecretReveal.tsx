import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { copyToClipboard } from '../lib/utils';
import { Button } from './ui';

/** Displays a one-time secret (temporary password, recovery codes) with a copy button. */
export function SecretReveal({ value, multiline }: { value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2">
      <pre className={`flex-1 rounded-md bg-slate-100 px-3 py-2 font-mono text-sm break-all whitespace-pre-wrap select-all dark:bg-slate-800 ${multiline ? 'leading-7' : ''}`}>{value}</pre>
      <Button
        variant="secondary"
        size="sm"
        icon={copied ? <Check className="size-4 text-green-600" /> : <Copy className="size-4" />}
        onClick={async () => {
          if (await copyToClipboard(value)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}
