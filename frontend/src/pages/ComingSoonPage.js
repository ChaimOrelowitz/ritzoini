export default function ComingSoonPage({ title }) {
  return (
    <div style={{ padding: '60px 32px', textAlign: 'center', color: 'var(--gray-400)' }}>
      <div style={{ fontSize: '2rem', marginBottom: 12 }}>🚧</div>
      <div style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--navy)', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: '0.9rem' }}>Coming soon.</div>
    </div>
  );
}
