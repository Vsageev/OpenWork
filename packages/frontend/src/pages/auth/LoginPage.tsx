import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Input, Card } from '../../ui';
import { useAuth } from '../../stores/useAuth';
import { getErrorMessage } from '../../lib/error-messages';
import styles from './AuthPage.module.css';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';

export function LoginPage() {
  useDocumentTitle('Sign In');
  const { login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await login(email, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} className={styles.form}>
        <div className={styles.header}>
          <h1 className={styles.title}>Sign in</h1>
          <p className={styles.subtitle}>Enter your credentials to access your account</p>
        </div>

        {error && <div className={styles.alert}>{error}</div>}

        <Input
          label="Email"
          type="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          autoFocus
        />

        <Input
          label="Password"
          type="password"
          placeholder="Enter your password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
        />

        <Button type="submit" size="lg" disabled={loading}>
          {loading ? 'Signing in...' : 'Sign in'}
        </Button>

        <p className={styles.footer}>
          Don&apos;t have an account? <Link to="/register">Create one</Link>
        </p>
      </form>
    </Card>
  );
}
