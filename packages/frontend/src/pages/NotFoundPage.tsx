import { Link, useNavigate } from 'react-router-dom';
import { FileQuestion } from 'lucide-react';
import { Button } from '../ui';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import styles from './NotFoundPage.module.css';

export function NotFoundPage() {
  useDocumentTitle('Not Found');
  const navigate = useNavigate();

  return (
    <div className={styles.page}>
      <div className={styles.icon}>
        <FileQuestion size={40} strokeWidth={1.2} />
      </div>
      <h1 className={styles.code}>404</h1>
      <p className={styles.message}>
        The page you're looking for doesn't exist or has been moved.
      </p>
      <div className={styles.actions}>
        <Button variant="ghost" onClick={() => navigate(-1)}>
          Go Back
        </Button>
        <Link to="/">
          <Button>Dashboard</Button>
        </Link>
      </div>
    </div>
  );
}
