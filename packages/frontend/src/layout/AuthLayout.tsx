import { Outlet } from 'react-router-dom';
import styles from './AuthLayout.module.css';

export function AuthLayout() {
  return (
    <div className={styles.layout}>
      <div className={styles.brandPanel}>
        <div className={styles.brandTop}>
          <span className={styles.brandName}>OpenWork</span>
        </div>

        <div className={styles.heroSection}>
          <div className={styles.logoMark} aria-hidden="true">
            <div className={styles.square} />
            <div className={styles.square} />
            <div className={styles.square} />
            <div className={styles.square} />
          </div>
          <h1 className={styles.heroTitle}>Your work, open.</h1>
        </div>

        <div className={styles.brandFooter} />
      </div>

      <div className={styles.formPanel}>
        <div className={styles.formContainer}>
          <div className={styles.formLogo}>OpenWork</div>
          <Outlet />
        </div>
      </div>
    </div>
  );
}
