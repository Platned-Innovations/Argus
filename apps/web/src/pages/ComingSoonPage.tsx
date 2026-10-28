import { Hourglass } from 'lucide-react';
import { Card, EmptyState, PageHeader } from '../components/ui';

export function ComingSoonPage({ title, description, phase }: { title: string; description: string; phase: string }) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <Card>
        <EmptyState icon={<Hourglass className="size-5" />} title="Coming in a later phase" description={`This area is delivered in the "${phase}" phase of the Argus roadmap.`} />
      </Card>
    </>
  );
}
