import { useState, useCallback } from 'react';
import { Mail, Calendar, Shield, Check } from 'lucide-react';
import { Button } from '../../ui';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../stores/toast';
import { useAuth } from '../../stores/useAuth';
import styles from './ProfileTab.module.css';

const STRENGTH_LABELS = ['Weak', 'Fair', 'Good', 'Strong'];

function getPasswordStrength(password: string): number {
  let score = 0;
  if (password.length >= 8) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  return Math.min(score - 1, 3); // 0–3
}

function formatDate(dateStr: string | Date): string {
  const d = typeof dateStr === 'string' ? new Date(dateStr) : dateStr;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function ProfileTab() {
  const { user, refreshUser } = useAuth();

  // Profile editing
  const [firstName, setFirstName] = useState(user?.firstName ?? '');
  const [lastName, setLastName] = useState(user?.lastName ?? '');
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);

  // Password change
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');

  const profileDirty = firstName !== (user?.firstName ?? '') || lastName !== (user?.lastName ?? '');
  const passwordStrength = newPassword.length > 0 ? getPasswordStrength(newPassword) : -1;

  const handleSaveProfile = useCallback(async () => {
    if (!profileDirty || savingProfile) return;
    setSavingProfile(true);
    setProfileSaved(false);
    try {
      const body: Record<string, string> = {};
      if (firstName !== user?.firstName) body.firstName = firstName;
      if (lastName !== user?.lastName) body.lastName = lastName;

      await api('/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify(body),
      });

      await refreshUser();
      setProfileSaved(true);
      toast.success('Profile updated');
      setTimeout(() => setProfileSaved(false), 3000);
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to update profile');
    } finally {
      setSavingProfile(false);
    }
  }, [firstName, lastName, user, profileDirty, savingProfile, refreshUser]);

  const handleChangePassword = useCallback(async () => {
    setPasswordError('');
    setPasswordSuccess('');

    if (!currentPassword) {
      setPasswordError('Current password is required');
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match');
      return;
    }

    setChangingPassword(true);
    try {
      await api('/auth/password', {
        method: 'PATCH',
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordSuccess('Password changed successfully');
      toast.success('Password changed');
      setTimeout(() => setPasswordSuccess(''), 5000);
    } catch (err) {
      if (err instanceof ApiError) setPasswordError(err.message);
      else setPasswordError('Failed to change password');
    } finally {
      setChangingPassword(false);
    }
  }, [currentPassword, newPassword, confirmPassword]);

  if (!user) return null;

  const initials = `${user.firstName[0] ?? ''}${user.lastName[0] ?? ''}`.toUpperCase();

  return (
    <div className={styles.container}>
      {/* ── Identity ── */}
      <div className={styles.section}>
        <div>
          <h3 className={styles.sectionTitle}>Profile</h3>
          <p className={styles.sectionDesc}>Your personal information and account details.</p>
        </div>

        <div className={styles.profileHeader}>
          <div className={styles.avatar}>{initials}</div>
          <div className={styles.profileInfo}>
            <div className={styles.profileName}>{user.firstName} {user.lastName}</div>
            <div className={styles.profileEmail}>{user.email}</div>
            <div className={styles.profileMeta}>Member since {formatDate(user.createdAt)}</div>
          </div>
        </div>
      </div>

      <div className={styles.sectionDivider} />

      {/* ── Edit Name ── */}
      <div className={styles.section}>
        <div>
          <h3 className={styles.sectionTitle}>Edit Name</h3>
          <p className={styles.sectionDesc}>Update your display name across the workspace.</p>
        </div>

        <div className={styles.form}>
          <div className={styles.fieldGroup}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="profile-first-name">First name</label>
              <input
                id="profile-first-name"
                className={styles.input}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                disabled={savingProfile}
                maxLength={100}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="profile-last-name">Last name</label>
              <input
                id="profile-last-name"
                className={styles.input}
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                disabled={savingProfile}
                maxLength={100}
              />
            </div>
          </div>

          <div className={styles.formActions}>
            <Button
              size="sm"
              onClick={handleSaveProfile}
              disabled={!profileDirty || savingProfile || !firstName.trim() || !lastName.trim()}
            >
              {savingProfile ? 'Saving...' : 'Save Changes'}
            </Button>
            {profileSaved && (
              <span className={styles.savedIndicator}>
                <Check size={14} /> Saved
              </span>
            )}
          </div>
        </div>
      </div>

      <div className={styles.sectionDivider} />

      {/* ── Account Info ── */}
      <div className={styles.section}>
        <div>
          <h3 className={styles.sectionTitle}>Account</h3>
          <p className={styles.sectionDesc}>Your account details and security status.</p>
        </div>

        <div className={styles.infoList}>
          <div className={styles.infoRow}>
            <Mail size={16} className={styles.infoIcon} />
            <div className={styles.infoContent}>
              <span className={styles.infoLabel}>Email</span>
              <span className={styles.infoValue}>{user.email}</span>
            </div>
          </div>
          <div className={styles.infoRow}>
            <Calendar size={16} className={styles.infoIcon} />
            <div className={styles.infoContent}>
              <span className={styles.infoLabel}>Joined</span>
              <span className={styles.infoValue}>{formatDate(user.createdAt)}</span>
            </div>
          </div>
          <div className={styles.infoRow}>
            <Shield size={16} className={styles.infoIcon} />
            <div className={styles.infoContent}>
              <span className={styles.infoLabel}>Account type</span>
              <span className={styles.infoValue}>User</span>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.sectionDivider} />

      {/* ── Change Password ── */}
      <div className={styles.section}>
        <div>
          <h3 className={styles.sectionTitle}>Change Password</h3>
          <p className={styles.sectionDesc}>Update your password. Must include uppercase, lowercase, number, and special character.</p>
        </div>

        {passwordError && <div className={styles.errorMsg}>{passwordError}</div>}
        {passwordSuccess && <div className={styles.successMsg}>{passwordSuccess}</div>}

        <div className={styles.form}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="current-password">Current password</label>
            <input
              id="current-password"
              type="password"
              className={styles.input}
              value={currentPassword}
              onChange={(e) => { setCurrentPassword(e.target.value); setPasswordError(''); }}
              disabled={changingPassword}
              autoComplete="current-password"
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="new-password">New password</label>
            <input
              id="new-password"
              type="password"
              className={styles.input}
              value={newPassword}
              onChange={(e) => { setNewPassword(e.target.value); setPasswordError(''); }}
              disabled={changingPassword}
              autoComplete="new-password"
            />
            {passwordStrength >= 0 && (
              <>
                <div className={styles.strengthBar}>
                  {[0, 1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className={`${styles.strengthSegment}${i <= passwordStrength ? ` ${styles[`strengthSegmentActive${passwordStrength}`]}` : ''}`}
                    />
                  ))}
                </div>
                <div className={styles.strengthLabel}>{STRENGTH_LABELS[passwordStrength]}</div>
              </>
            )}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="confirm-password">Confirm new password</label>
            <input
              id="confirm-password"
              type="password"
              className={`${styles.input}${confirmPassword && confirmPassword !== newPassword ? ` ${styles.inputError}` : ''}`}
              value={confirmPassword}
              onChange={(e) => { setConfirmPassword(e.target.value); setPasswordError(''); }}
              disabled={changingPassword}
              autoComplete="new-password"
            />
          </div>

          <div className={styles.formActions}>
            <Button
              size="sm"
              onClick={handleChangePassword}
              disabled={changingPassword || !currentPassword || !newPassword || !confirmPassword}
            >
              {changingPassword ? 'Changing...' : 'Change Password'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
