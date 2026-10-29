import { FindingsTable } from '../components/FindingsTable';
import { Card, PageHeader } from '../components/ui';

export function FindingsPage() {
  return (
    <>
      <PageHeader title="Findings" description="Security issues found by the scanners across the repositories you can see, highest risk first." />
      <Card>
        <FindingsTable savedViews />
      </Card>
    </>
  );
}
