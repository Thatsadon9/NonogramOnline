alter table nonogram_rooms add column if not exists started_at timestamptz;

alter table nonogram_room_players add column if not exists cursor_index integer;
