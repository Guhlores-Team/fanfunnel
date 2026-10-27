export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      autopilot_dismissals: {
        Row: {
          created_at: string
          creator_id: string
          dedupe_key: string
          snooze_until: string | null
        }
        Insert: {
          created_at?: string
          creator_id: string
          dedupe_key: string
          snooze_until?: string | null
        }
        Update: {
          created_at?: string
          creator_id?: string
          dedupe_key?: string
          snooze_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "autopilot_dismissals_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_packs: {
        Row: {
          amount_cents: number
          bonus_spins: number
          campaign_id: string | null
          created_at: string
          creator_id: string
          id: string
          label: string
          sort_order: number
          spins: number
        }
        Insert: {
          amount_cents?: number
          bonus_spins?: number
          campaign_id?: string | null
          created_at?: string
          creator_id: string
          id?: string
          label: string
          sort_order?: number
          spins?: number
        }
        Update: {
          amount_cents?: number
          bonus_spins?: number
          campaign_id?: string | null
          created_at?: string
          creator_id?: string
          id?: string
          label?: string
          sort_order?: number
          spins?: number
        }
        Relationships: [
          {
            foreignKeyName: "campaign_packs_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_packs_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          created_at: string
          creator_id: string
          id: string
          is_active: boolean
          name: string
          pinned_wheel_id: string | null
        }
        Insert: {
          created_at?: string
          creator_id: string
          id?: string
          is_active?: boolean
          name: string
          pinned_wheel_id?: string | null
        }
        Update: {
          created_at?: string
          creator_id?: string
          id?: string
          is_active?: boolean
          name?: string
          pinned_wheel_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_pinned_wheel_id_fkey"
            columns: ["pinned_wheel_id"]
            isOneToOne: false
            referencedRelation: "wheels"
            referencedColumns: ["id"]
          },
        ]
      }
      creator_applications: {
        Row: {
          audience_size: string | null
          created_at: string
          decided_at: string | null
          display_name: string | null
          email: string | null
          id: string
          note: string | null
          profile_id: string
          socials: string | null
          status: Database["public"]["Enums"]["creator_approval"]
        }
        Insert: {
          audience_size?: string | null
          created_at?: string
          decided_at?: string | null
          display_name?: string | null
          email?: string | null
          id?: string
          note?: string | null
          profile_id: string
          socials?: string | null
          status?: Database["public"]["Enums"]["creator_approval"]
        }
        Update: {
          audience_size?: string | null
          created_at?: string
          decided_at?: string | null
          display_name?: string | null
          email?: string | null
          id?: string
          note?: string | null
          profile_id?: string
          socials?: string | null
          status?: Database["public"]["Enums"]["creator_approval"]
        }
        Relationships: [
          {
            foreignKeyName: "creator_applications_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      creator_reports: {
        Row: {
          created_at: string
          creator_id: string
          detail: string | null
          fan_id: string | null
          id: string
          reason: string
          status: string
          token: string | null
        }
        Insert: {
          created_at?: string
          creator_id: string
          detail?: string | null
          fan_id?: string | null
          id?: string
          reason: string
          status?: string
          token?: string | null
        }
        Update: {
          created_at?: string
          creator_id?: string
          detail?: string | null
          fan_id?: string | null
          id?: string
          reason?: string
          status?: string
          token?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "creator_reports_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creator_reports_fan_id_fkey"
            columns: ["fan_id"]
            isOneToOne: false
            referencedRelation: "fans"
            referencedColumns: ["id"]
          },
        ]
      }
      dm_templates: {
        Row: {
          body: string
          created_at: string
          creator_id: string
          id: string
          title: string
        }
        Insert: {
          body: string
          created_at?: string
          creator_id: string
          id?: string
          title: string
        }
        Update: {
          body?: string
          created_at?: string
          creator_id?: string
          id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "dm_templates_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      fan_passes: {
        Row: {
          campaign_id: string | null
          created_at: string
          creator_id: string
          fan_id: string
          id: string
          is_active: boolean
          last_spin_at: string | null
          next_server_seed: string | null
          next_server_seed_hash: string | null
          self_excluded_at: string | null
          spins_granted_total: number
          spins_remaining: number
          token: string
          wheel_id: string
        }
        Insert: {
          campaign_id?: string | null
          created_at?: string
          creator_id: string
          fan_id: string
          id?: string
          is_active?: boolean
          last_spin_at?: string | null
          next_server_seed?: string | null
          next_server_seed_hash?: string | null
          self_excluded_at?: string | null
          spins_granted_total?: number
          spins_remaining?: number
          token: string
          wheel_id: string
        }
        Update: {
          campaign_id?: string | null
          created_at?: string
          creator_id?: string
          fan_id?: string
          id?: string
          is_active?: boolean
          last_spin_at?: string | null
          next_server_seed?: string | null
          next_server_seed_hash?: string | null
          self_excluded_at?: string | null
          spins_granted_total?: number
          spins_remaining?: number
          token?: string
          wheel_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fan_passes_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fan_passes_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fan_passes_fan_id_fkey"
            columns: ["fan_id"]
            isOneToOne: false
            referencedRelation: "fans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fan_passes_wheel_id_fkey"
            columns: ["wheel_id"]
            isOneToOne: false
            referencedRelation: "wheels"
            referencedColumns: ["id"]
          },
        ]
      }
      fans: {
        Row: {
          acked_at: string | null
          blocked_at: string | null
          created_at: string
          creator_id: string
          display_name: string | null
          handle: string | null
          id: string
          last_spin_at: string | null
          leaderboard_opt_in: boolean
          notes: string | null
          pity_counter: number
          referral_code: string | null
          referral_credited: boolean
          referred_by_fan_id: string | null
          rl_count: number
          rl_window_start: string | null
          spins_granted_total: number
          spins_remaining: number
          tags: string[]
        }
        Insert: {
          acked_at?: string | null
          blocked_at?: string | null
          created_at?: string
          creator_id: string
          display_name?: string | null
          handle?: string | null
          id?: string
          last_spin_at?: string | null
          leaderboard_opt_in?: boolean
          notes?: string | null
          pity_counter?: number
          referral_code?: string | null
          referral_credited?: boolean
          referred_by_fan_id?: string | null
          rl_count?: number
          rl_window_start?: string | null
          spins_granted_total?: number
          spins_remaining?: number
          tags?: string[]
        }
        Update: {
          acked_at?: string | null
          blocked_at?: string | null
          created_at?: string
          creator_id?: string
          display_name?: string | null
          handle?: string | null
          id?: string
          last_spin_at?: string | null
          leaderboard_opt_in?: boolean
          notes?: string | null
          pity_counter?: number
          referral_code?: string | null
          referral_credited?: boolean
          referred_by_fan_id?: string | null
          rl_count?: number
          rl_window_start?: string | null
          spins_granted_total?: number
          spins_remaining?: number
          tags?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "fans_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fans_referred_by_fan_id_fkey"
            columns: ["referred_by_fan_id"]
            isOneToOne: false
            referencedRelation: "fans"
            referencedColumns: ["id"]
          },
        ]
      }
      grants: {
        Row: {
          amount_cents: number
          bonus_spins: number
          campaign_id: string | null
          created_at: string
          creator_id: string
          fan_id: string
          fan_pass_id: string | null
          id: string
          spins: number
        }
        Insert: {
          amount_cents?: number
          bonus_spins?: number
          campaign_id?: string | null
          created_at?: string
          creator_id: string
          fan_id: string
          fan_pass_id?: string | null
          id?: string
          spins?: number
        }
        Update: {
          amount_cents?: number
          bonus_spins?: number
          campaign_id?: string | null
          created_at?: string
          creator_id?: string
          fan_id?: string
          fan_pass_id?: string | null
          id?: string
          spins?: number
        }
        Relationships: [
          {
            foreignKeyName: "grants_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grants_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grants_fan_id_fkey"
            columns: ["fan_id"]
            isOneToOne: false
            referencedRelation: "fans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grants_fan_pass_id_fkey"
            columns: ["fan_pass_id"]
            isOneToOne: false
            referencedRelation: "fan_passes"
            referencedColumns: ["id"]
          },
        ]
      }
      happy_hours: {
        Row: {
          created_at: string
          creator_id: string
          ends_at: string
          id: string
          multiplier: number
          starts_at: string
          wheel_id: string
        }
        Insert: {
          created_at?: string
          creator_id: string
          ends_at: string
          id?: string
          multiplier?: number
          starts_at: string
          wheel_id: string
        }
        Update: {
          created_at?: string
          creator_id?: string
          ends_at?: string
          id?: string
          multiplier?: number
          starts_at?: string
          wheel_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "happy_hours_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "happy_hours_wheel_id_fkey"
            columns: ["wheel_id"]
            isOneToOne: false
            referencedRelation: "wheels"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          body: string
          created_at: string
          creator_id: string
          fan_id: string
          id: string
          read_at: string | null
          sender: Database["public"]["Enums"]["message_sender"]
        }
        Insert: {
          body: string
          created_at?: string
          creator_id: string
          fan_id: string
          id?: string
          read_at?: string | null
          sender: Database["public"]["Enums"]["message_sender"]
        }
        Update: {
          body?: string
          created_at?: string
          creator_id?: string
          fan_id?: string
          id?: string
          read_at?: string | null
          sender?: Database["public"]["Enums"]["message_sender"]
        }
        Relationships: [
          {
            foreignKeyName: "messages_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_fan_id_fkey"
            columns: ["fan_id"]
            isOneToOne: false
            referencedRelation: "fans"
            referencedColumns: ["id"]
          },
        ]
      }
      org_invites: {
        Row: {
          created_at: string
          email: string
          id: string
          org_id: string
          status: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          org_id: string
          status?: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          org_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_invites_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      org_member_creators: {
        Row: {
          creator_id: string
          member_id: string
        }
        Insert: {
          creator_id: string
          member_id: string
        }
        Update: {
          creator_id?: string
          member_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_member_creators_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_member_creators_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "org_members"
            referencedColumns: ["id"]
          },
        ]
      }
      org_members: {
        Row: {
          created_at: string
          id: string
          org_id: string
          profile_id: string
          role: Database["public"]["Enums"]["org_role"]
        }
        Insert: {
          created_at?: string
          id?: string
          org_id: string
          profile_id: string
          role?: Database["public"]["Enums"]["org_role"]
        }
        Update: {
          created_at?: string
          id?: string
          org_id?: string
          profile_id?: string
          role?: Database["public"]["Enums"]["org_role"]
        }
        Relationships: [
          {
            foreignKeyName: "org_members_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_members_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      orgs: {
        Row: {
          billing_model: string
          created_at: string
          id: string
          name: string
          owner_id: string
        }
        Insert: {
          billing_model?: string
          created_at?: string
          id?: string
          name: string
          owner_id: string
        }
        Update: {
          billing_model?: string
          created_at?: string
          id?: string
          name?: string
          owner_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "orgs_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      prize_templates: {
        Row: {
          color: string | null
          created_at: string
          creator_id: string
          description: string | null
          emoji: string | null
          id: string
          label: string
          rarity: Database["public"]["Enums"]["prize_rarity"]
          weight: number
        }
        Insert: {
          color?: string | null
          created_at?: string
          creator_id: string
          description?: string | null
          emoji?: string | null
          id?: string
          label: string
          rarity?: Database["public"]["Enums"]["prize_rarity"]
          weight?: number
        }
        Update: {
          color?: string | null
          created_at?: string
          creator_id?: string
          description?: string | null
          emoji?: string | null
          id?: string
          label?: string
          rarity?: Database["public"]["Enums"]["prize_rarity"]
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "prize_templates_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      prizes: {
        Row: {
          color: string | null
          cost_cents: number | null
          created_at: string
          description: string | null
          emoji: string | null
          id: string
          image_url: string | null
          label: string
          rarity: Database["public"]["Enums"]["prize_rarity"]
          sort_order: number
          stock: number | null
          weight: number
          wheel_id: string
        }
        Insert: {
          color?: string | null
          cost_cents?: number | null
          created_at?: string
          description?: string | null
          emoji?: string | null
          id?: string
          image_url?: string | null
          label: string
          rarity?: Database["public"]["Enums"]["prize_rarity"]
          sort_order?: number
          stock?: number | null
          weight?: number
          wheel_id: string
        }
        Update: {
          color?: string | null
          cost_cents?: number | null
          created_at?: string
          description?: string | null
          emoji?: string | null
          id?: string
          image_url?: string | null
          label?: string
          rarity?: Database["public"]["Enums"]["prize_rarity"]
          sort_order?: number
          stock?: number | null
          weight?: number
          wheel_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "prizes_wheel_id_fkey"
            columns: ["wheel_id"]
            isOneToOne: false
            referencedRelation: "wheels"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          approval_status: Database["public"]["Enums"]["creator_approval"]
          avatar_url: string | null
          chat_intro: string | null
          chat_outro: string | null
          created_at: string
          creator_note: string | null
          display_name: string | null
          email: string | null
          features: Json
          id: string
          is_active: boolean
          leaderboard_enabled: boolean
          notifications_seen_at: string | null
          notify_low_balance: boolean
          notify_messages: boolean
          notify_new_spin: boolean
          onboarding_dismissed: boolean
          org_id: string | null
          public_slug: string | null
          public_tagline: string | null
          role: Database["public"]["Enums"]["app_role"]
          tip_url: string | null
        }
        Insert: {
          approval_status?: Database["public"]["Enums"]["creator_approval"]
          avatar_url?: string | null
          chat_intro?: string | null
          chat_outro?: string | null
          created_at?: string
          creator_note?: string | null
          display_name?: string | null
          email?: string | null
          features?: Json
          id: string
          is_active?: boolean
          leaderboard_enabled?: boolean
          notifications_seen_at?: string | null
          notify_low_balance?: boolean
          notify_messages?: boolean
          notify_new_spin?: boolean
          onboarding_dismissed?: boolean
          org_id?: string | null
          public_slug?: string | null
          public_tagline?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          tip_url?: string | null
        }
        Update: {
          approval_status?: Database["public"]["Enums"]["creator_approval"]
          avatar_url?: string | null
          chat_intro?: string | null
          chat_outro?: string | null
          created_at?: string
          creator_note?: string | null
          display_name?: string | null
          email?: string | null
          features?: Json
          id?: string
          is_active?: boolean
          leaderboard_enabled?: boolean
          notifications_seen_at?: string | null
          notify_low_balance?: boolean
          notify_messages?: boolean
          notify_new_spin?: boolean
          onboarding_dismissed?: boolean
          org_id?: string | null
          public_slug?: string | null
          public_tagline?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          tip_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      redemptions: {
        Row: {
          created_at: string
          creator_id: string
          due_at: string | null
          fulfilled_at: string | null
          id: string
          notes: string | null
          spin_id: string
          status: Database["public"]["Enums"]["redemption_status"]
        }
        Insert: {
          created_at?: string
          creator_id: string
          due_at?: string | null
          fulfilled_at?: string | null
          id?: string
          notes?: string | null
          spin_id: string
          status?: Database["public"]["Enums"]["redemption_status"]
        }
        Update: {
          created_at?: string
          creator_id?: string
          due_at?: string | null
          fulfilled_at?: string | null
          id?: string
          notes?: string | null
          spin_id?: string
          status?: Database["public"]["Enums"]["redemption_status"]
        }
        Relationships: [
          {
            foreignKeyName: "redemptions_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "redemptions_spin_id_fkey"
            columns: ["spin_id"]
            isOneToOne: false
            referencedRelation: "spins"
            referencedColumns: ["id"]
          },
        ]
      }
      referrals: {
        Row: {
          bonus_spins: number
          created_at: string
          creator_id: string
          credited_at: string | null
          id: string
          referred_fan_id: string
          referrer_fan_id: string
        }
        Insert: {
          bonus_spins?: number
          created_at?: string
          creator_id: string
          credited_at?: string | null
          id?: string
          referred_fan_id: string
          referrer_fan_id: string
        }
        Update: {
          bonus_spins?: number
          created_at?: string
          creator_id?: string
          credited_at?: string | null
          id?: string
          referred_fan_id?: string
          referrer_fan_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "referrals_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referrals_referred_fan_id_fkey"
            columns: ["referred_fan_id"]
            isOneToOne: true
            referencedRelation: "fans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referrals_referrer_fan_id_fkey"
            columns: ["referrer_fan_id"]
            isOneToOne: false
            referencedRelation: "fans"
            referencedColumns: ["id"]
          },
        ]
      }
      spins: {
        Row: {
          campaign_id: string | null
          client_seed: string | null
          created_at: string
          creator_id: string
          fair_trace: Json | null
          fair_version: number | null
          fan_id: string | null
          fan_pass_id: string
          id: string
          nonce: number | null
          pool_hash: string | null
          pool_snapshot: Json | null
          prize_id: string | null
          prize_image_url: string | null
          prize_label: string
          prize_rarity: Database["public"]["Enums"]["prize_rarity"]
          seed_commitment: string | null
          server_seed: string | null
          server_seed_hash: string | null
          share_id: string | null
          wheel_id: string
        }
        Insert: {
          campaign_id?: string | null
          client_seed?: string | null
          created_at?: string
          creator_id: string
          fair_trace?: Json | null
          fair_version?: number | null
          fan_id?: string | null
          fan_pass_id: string
          id?: string
          nonce?: number | null
          pool_hash?: string | null
          pool_snapshot?: Json | null
          prize_id?: string | null
          prize_image_url?: string | null
          prize_label: string
          prize_rarity?: Database["public"]["Enums"]["prize_rarity"]
          seed_commitment?: string | null
          server_seed?: string | null
          server_seed_hash?: string | null
          share_id?: string | null
          wheel_id: string
        }
        Update: {
          campaign_id?: string | null
          client_seed?: string | null
          created_at?: string
          creator_id?: string
          fair_trace?: Json | null
          fair_version?: number | null
          fan_id?: string | null
          fan_pass_id?: string
          id?: string
          nonce?: number | null
          pool_hash?: string | null
          pool_snapshot?: Json | null
          prize_id?: string | null
          prize_image_url?: string | null
          prize_label?: string
          prize_rarity?: Database["public"]["Enums"]["prize_rarity"]
          seed_commitment?: string | null
          server_seed?: string | null
          server_seed_hash?: string | null
          share_id?: string | null
          wheel_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "spins_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spins_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spins_fan_id_fkey"
            columns: ["fan_id"]
            isOneToOne: false
            referencedRelation: "fans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spins_fan_pass_id_fkey"
            columns: ["fan_pass_id"]
            isOneToOne: false
            referencedRelation: "fan_passes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spins_prize_id_fkey"
            columns: ["prize_id"]
            isOneToOne: false
            referencedRelation: "prizes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spins_wheel_id_fkey"
            columns: ["wheel_id"]
            isOneToOne: false
            referencedRelation: "wheels"
            referencedColumns: ["id"]
          },
        ]
      }
      webhooks: {
        Row: {
          created_at: string
          creator_id: string
          event: string
          id: string
          url: string
        }
        Insert: {
          created_at?: string
          creator_id: string
          event?: string
          id?: string
          url: string
        }
        Update: {
          created_at?: string
          creator_id?: string
          event?: string
          id?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhooks_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      wheel_templates: {
        Row: {
          brand_color: string
          created_at: string
          creator_id: string
          id: string
          name: string
          prizes: Json
          subtitle: string | null
          title: string
        }
        Insert: {
          brand_color?: string
          created_at?: string
          creator_id: string
          id?: string
          name: string
          prizes?: Json
          subtitle?: string | null
          title?: string
        }
        Update: {
          brand_color?: string
          created_at?: string
          creator_id?: string
          id?: string
          name?: string
          prizes?: Json
          subtitle?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "wheel_templates_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      wheels: {
        Row: {
          active_from: string | null
          active_until: string | null
          archived_at: string | null
          brand_color: string
          created_at: string
          creator_id: string
          id: string
          is_active: boolean
          label_color: string | null
          label_size: string | null
          subtitle: string | null
          title: string
          updated_at: string
        }
        Insert: {
          active_from?: string | null
          active_until?: string | null
          archived_at?: string | null
          brand_color?: string
          created_at?: string
          creator_id: string
          id?: string
          is_active?: boolean
          label_color?: string | null
          label_size?: string | null
          subtitle?: string | null
          title?: string
          updated_at?: string
        }
        Update: {
          active_from?: string | null
          active_until?: string | null
          archived_at?: string | null
          brand_color?: string
          created_at?: string
          creator_id?: string
          id?: string
          is_active?: boolean
          label_color?: string | null
          label_size?: string | null
          subtitle?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "wheels_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      wishlists: {
        Row: {
          created_at: string
          creator_id: string
          fan_id: string
          id: string
          prize_id: string | null
          prize_label: string
          prize_rarity: Database["public"]["Enums"]["prize_rarity"]
        }
        Insert: {
          created_at?: string
          creator_id: string
          fan_id: string
          id?: string
          prize_id?: string | null
          prize_label: string
          prize_rarity?: Database["public"]["Enums"]["prize_rarity"]
        }
        Update: {
          created_at?: string
          creator_id?: string
          fan_id?: string
          id?: string
          prize_id?: string | null
          prize_label?: string
          prize_rarity?: Database["public"]["Enums"]["prize_rarity"]
        }
        Relationships: [
          {
            foreignKeyName: "wishlists_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wishlists_fan_id_fkey"
            columns: ["fan_id"]
            isOneToOne: false
            referencedRelation: "fans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wishlists_prize_id_fkey"
            columns: ["prize_id"]
            isOneToOne: false
            referencedRelation: "prizes"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      _owns_org: { Args: { p_org: string }; Returns: boolean }
      admin_account_stats: {
        Args: never
        Returns: {
          display_name: string
          email: string
          fans: number
          features: Json
          id: string
          is_active: boolean
          pending: number
          role: Database["public"]["Enums"]["app_role"]
          spins: number
          wheels: number
        }[]
      }
      admin_reserve_account_deletion: {
        Args: { p_target: string }
        Returns: string
      }
      can_act_for: {
        Args: { perm: string; target_creator: string }
        Returns: boolean
      }
      claim_spin: { Args: { p_token: string }; Returns: number }
      credit_pass_spins: {
        Args: { p_fan_id: string; p_spins: number }
        Returns: undefined
      }
      current_user_active: { Args: never; Returns: boolean }
      import_fans: { Args: { p_rows: Json }; Returns: undefined }
      is_admin: { Args: never; Returns: boolean }
      org_account_stats: {
        Args: { p_org: string }
        Returns: {
          display_name: string
          email: string
          fans: number
          features: Json
          id: string
          is_active: boolean
          pending: number
          revenue: number
          role: Database["public"]["Enums"]["app_role"]
          spins: number
          wheels: number
        }[]
      }
      org_add_creator: {
        Args: { p_email: string; p_org: string }
        Returns: string
      }
      org_add_member: {
        Args: {
          p_email: string
          p_org: string
          p_role: Database["public"]["Enums"]["org_role"]
        }
        Returns: string
      }
      org_create: { Args: { p_name: string }; Returns: string }
      org_invite_creator: {
        Args: { p_email: string; p_org: string }
        Returns: string
      }
      org_invite_respond: {
        Args: { p_accept: boolean; p_invite: string }
        Returns: string
      }
      org_invite_revoke: { Args: { p_invite: string }; Returns: string }
      org_remove_creator: {
        Args: { p_creator: string; p_org: string }
        Returns: string
      }
      org_remove_member: { Args: { p_member: string }; Returns: string }
      org_scope_creator: {
        Args: { p_creator: string; p_member: string; p_on: boolean }
        Returns: string
      }
      rollback_claimed_spin: {
        Args: { p_prize_id: string; p_token: string }
        Returns: undefined
      }
      set_chat_settings: {
        Args: { p_intro: string; p_outro: string }
        Returns: undefined
      }
      set_creator_note: {
        Args: { p_avatar: string; p_note: string }
        Returns: undefined
      }
      set_display_name: { Args: { p_name: string }; Returns: undefined }
      set_leaderboard_enabled: {
        Args: { p_enabled: boolean }
        Returns: undefined
      }
      set_notification_prefs: {
        Args: {
          p_low_balance: boolean
          p_messages: boolean
          p_new_spin: boolean
        }
        Returns: undefined
      }
      set_notifications_seen: { Args: never; Returns: undefined }
      set_onboarding_dismissed: {
        Args: { p_dismissed: boolean }
        Returns: undefined
      }
      set_public_profile: {
        Args: { p_slug: string; p_tagline: string; p_tip_url: string }
        Returns: undefined
      }
    }
    Enums: {
      app_role: "admin" | "creator"
      creator_approval: "pending" | "approved" | "rejected"
      message_sender: "fan" | "creator"
      org_role: "owner" | "manager" | "chatter" | "fulfiller" | "analyst"
      prize_rarity: "common" | "uncommon" | "rare" | "epic" | "legendary"
      redemption_status: "pending" | "fulfilled" | "cancelled" | "in_progress"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "creator"],
      creator_approval: ["pending", "approved", "rejected"],
      message_sender: ["fan", "creator"],
      org_role: ["owner", "manager", "chatter", "fulfiller", "analyst"],
      prize_rarity: ["common", "uncommon", "rare", "epic", "legendary"],
      redemption_status: ["pending", "fulfilled", "cancelled", "in_progress"],
    },
  },
} as const
