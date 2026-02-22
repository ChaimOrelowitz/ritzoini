-- ============================================
-- RITZOINI Platform — Database Schema
-- Paste and run this in your Supabase SQL Editor
-- ============================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────
-- PROFILES (extends Supabase auth.users)
-- ─────────────────────────────────────────
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'supervisor')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, email, name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'name', NEW.email),
    COALESCE(NEW.raw_user_meta_data->>'role', 'supervisor')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ─────────────────────────────────────────
-- GROUPS
-- ─────────────────────────────────────────
CREATE TABLE groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  supervisor_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  total_sessions INT NOT NULL DEFAULT 8,
  start_date DATE NOT NULL,
  day_of_week TEXT NOT NULL CHECK (day_of_week IN ('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')),
  session_time TIME NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'stopped')),
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- SESSIONS
-- ─────────────────────────────────────────
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  session_number INT NOT NULL,
  scheduled_date DATE NOT NULL,
  scheduled_time TIME NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  notes TEXT,
  email_sent_at TIMESTAMPTZ,
  ready_to_lock_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  locked_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, session_number)
);

-- ─────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ─────────────────────────────────────────
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read profiles" ON profiles FOR SELECT USING (true);
CREATE POLICY "Users update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Admins manage groups" ON groups FOR ALL
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');

CREATE POLICY "Supervisors read own groups" ON groups FOR SELECT
  USING (supervisor_id = auth.uid());

CREATE POLICY "Supervisors update own groups" ON groups FOR UPDATE
  USING (supervisor_id = auth.uid());

CREATE POLICY "Admins manage sessions" ON sessions FOR ALL
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');

CREATE POLICY "Supervisors manage own sessions" ON sessions FOR ALL
  USING (
    (SELECT supervisor_id FROM groups WHERE id = group_id) = auth.uid()
  );

-- ─────────────────────────────────────────
-- FUNCTION: Generate weekly sessions for a group
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION generate_sessions_for_group(p_group_id UUID)
RETURNS VOID AS $$
DECLARE
  g groups%ROWTYPE;
  i INT;
  first_date DATE;
  day_num INT;
  days_ahead INT;
BEGIN
  SELECT * INTO g FROM groups WHERE id = p_group_id;

  day_num := CASE g.day_of_week
    WHEN 'Sunday'    THEN 0
    WHEN 'Monday'    THEN 1
    WHEN 'Tuesday'   THEN 2
    WHEN 'Wednesday' THEN 3
    WHEN 'Thursday'  THEN 4
    WHEN 'Friday'    THEN 5
    WHEN 'Saturday'  THEN 6
  END;

  days_ahead := (day_num - EXTRACT(DOW FROM g.start_date)::INT + 7) % 7;
  first_date := g.start_date + (days_ahead * INTERVAL '1 day');

  FOR i IN 1..g.total_sessions LOOP
    INSERT INTO sessions (group_id, session_number, scheduled_date, scheduled_time)
    VALUES (
      p_group_id,
      i,
      first_date + ((i - 1) * 7 * INTERVAL '1 day'),
      g.session_time
    )
    ON CONFLICT (group_id, session_number) DO NOTHING;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
