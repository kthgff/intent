import { Link } from 'react-router-dom';
import type { InboxItem } from '../../src/api';
import { KindBadge } from '../../src/components';
import { itemTarget } from '../../src/screens/Inbox';

/** Presentational slice of the inbox card for ordering tests. */
export default function InboxCard({ item }: { item: InboxItem }) {
  return (
    <div className="card">
      <KindBadge kind={item.kind} />
      <Link to={itemTarget(item)}>
        {item.subject} · {item.gate}
      </Link>
    </div>
  );
}
