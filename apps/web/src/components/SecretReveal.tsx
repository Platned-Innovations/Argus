import { Check, Copy } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { copyToClipboard } from '../lib/utils';
import { Button } from './ui';

/** Displays a one-time secret (temporary password, recovery codes, invite link) with a copy button. */
export function SecretReveal({ value, multiline }: { value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="flex items-start gap-2">
      <pre ref={ref} className={`flex-1 rounded-md bg-slate-100 px-3 py-2 font-mono text-sm break-all whitespace-pre-wrap select-all dark:bg-slate-800 ${multiline ? 'leading-7' : ''}`}>
        {value}
      </pre>
      <Button
        variant="secondary"
        size="sm"
        icon={copied ? <Check className="size-4 text-green-600" /> : <Copy className="size-4" />}
        onClick={async () => {
          if (await copyToClipboard(value)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
            return;
          }
          // The browser refused to copy: select the text so one key press copies it.
          const selection = window.getSelection();
          if (ref.current && selection) {
            selection.selectAllChildren(ref.current);
            toast.info('Copying is blocked by the browser. The text is selected: press Ctrl+C (⌘C on a Mac) to copy it.');
          }
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}
