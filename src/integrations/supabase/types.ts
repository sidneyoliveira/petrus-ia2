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
      cnpj_cache: {
        Row: {
          ativo: boolean | null
          cnae_descricao: string | null
          cnae_principal: string | null
          cnpj: string
          fetched_at: string
          municipio: string | null
          nome_fantasia: string | null
          payload: Json | null
          razao_social: string | null
          situacao: string | null
          uf: string | null
        }
        Insert: {
          ativo?: boolean | null
          cnae_descricao?: string | null
          cnae_principal?: string | null
          cnpj: string
          fetched_at?: string
          municipio?: string | null
          nome_fantasia?: string | null
          payload?: Json | null
          razao_social?: string | null
          situacao?: string | null
          uf?: string | null
        }
        Update: {
          ativo?: boolean | null
          cnae_descricao?: string | null
          cnae_principal?: string | null
          cnpj?: string
          fetched_at?: string
          municipio?: string | null
          nome_fantasia?: string | null
          payload?: Json | null
          razao_social?: string | null
          situacao?: string | null
          uf?: string | null
        }
        Relationships: []
      }
      price_sources: {
        Row: {
          category: string
          created_at: string
          discovered_auto: boolean
          domain: string
          enabled: boolean
          hits: number
          id: string
          inciso: string | null
          last_used_at: string | null
          name: string
          notes: string | null
          priority: number
          successes: number
          updated_at: string
        }
        Insert: {
          category: string
          created_at?: string
          discovered_auto?: boolean
          domain: string
          enabled?: boolean
          hits?: number
          id?: string
          inciso?: string | null
          last_used_at?: string | null
          name: string
          notes?: string | null
          priority?: number
          successes?: number
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          discovered_auto?: boolean
          domain?: string
          enabled?: boolean
          hits?: number
          id?: string
          inciso?: string | null
          last_used_at?: string | null
          name?: string
          notes?: string | null
          priority?: number
          successes?: number
          updated_at?: string
        }
        Relationships: []
      }
      quote_items: {
        Row: {
          cnpj: string | null
          created_at: string
          data: string | null
          descricao: string | null
          documento: string | null
          embedding: string | null
          embedding_at: string | null
          embedding_status: string | null
          fingerprint: string
          fornecedor: string | null
          homologado: boolean | null
          id: string
          modalidade: string | null
          municipio: string | null
          orgao: string | null
          origem: string | null
          payload: Json
          quantidade: number | null
          query_norm: string
          score_final: number | null
          search_id: string | null
          source_excerpt: string | null
          source_payload_raw: Json | null
          titulo: string
          uf: string | null
          unidade: string | null
          updated_at: string
          url: string | null
          valor: number | null
          valor_inferido: number | null
          valor_inferido_at: string | null
          valor_inferido_confianca: number | null
          valor_inferido_reason: string | null
          valor_inferido_status: string | null
          valor_tipo: string | null
          valor_total: number | null
        }
        Insert: {
          cnpj?: string | null
          created_at?: string
          data?: string | null
          descricao?: string | null
          documento?: string | null
          embedding?: string | null
          embedding_at?: string | null
          embedding_status?: string | null
          fingerprint: string
          fornecedor?: string | null
          homologado?: boolean | null
          id?: string
          modalidade?: string | null
          municipio?: string | null
          orgao?: string | null
          origem?: string | null
          payload: Json
          quantidade?: number | null
          query_norm: string
          score_final?: number | null
          search_id?: string | null
          source_excerpt?: string | null
          source_payload_raw?: Json | null
          titulo: string
          uf?: string | null
          unidade?: string | null
          updated_at?: string
          url?: string | null
          valor?: number | null
          valor_inferido?: number | null
          valor_inferido_at?: string | null
          valor_inferido_confianca?: number | null
          valor_inferido_reason?: string | null
          valor_inferido_status?: string | null
          valor_tipo?: string | null
          valor_total?: number | null
        }
        Update: {
          cnpj?: string | null
          created_at?: string
          data?: string | null
          descricao?: string | null
          documento?: string | null
          embedding?: string | null
          embedding_at?: string | null
          embedding_status?: string | null
          fingerprint?: string
          fornecedor?: string | null
          homologado?: boolean | null
          id?: string
          modalidade?: string | null
          municipio?: string | null
          orgao?: string | null
          origem?: string | null
          payload?: Json
          quantidade?: number | null
          query_norm?: string
          score_final?: number | null
          search_id?: string | null
          source_excerpt?: string | null
          source_payload_raw?: Json | null
          titulo?: string
          uf?: string | null
          unidade?: string | null
          updated_at?: string
          url?: string | null
          valor?: number | null
          valor_inferido?: number | null
          valor_inferido_at?: string | null
          valor_inferido_confianca?: number | null
          valor_inferido_reason?: string | null
          valor_inferido_status?: string | null
          valor_tipo?: string | null
          valor_total?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "quote_items_search_id_fkey"
            columns: ["search_id"]
            isOneToOne: false
            referencedRelation: "quote_searches"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_searches: {
        Row: {
          computed_at: string
          created_at: string
          filters: Json
          filters_hash: string
          fresh_until: string
          id: string
          query_norm: string
          query_raw: string
          sources: Json
          took_ms: number
          total: number
        }
        Insert: {
          computed_at?: string
          created_at?: string
          filters?: Json
          filters_hash?: string
          fresh_until?: string
          id?: string
          query_norm: string
          query_raw: string
          sources?: Json
          took_ms?: number
          total?: number
        }
        Update: {
          computed_at?: string
          created_at?: string
          filters?: Json
          filters_hash?: string
          fresh_until?: string
          id?: string
          query_norm?: string
          query_raw?: string
          sources?: Json
          took_ms?: number
          total?: number
        }
        Relationships: []
      }
      search_feedback: {
        Row: {
          action: string
          created_at: string
          id: string
          item_id: string
          query: string
          query_norm: string
          reason: string | null
          snapshot: Json | null
          source: string
        }
        Insert: {
          action: string
          created_at?: string
          id?: string
          item_id: string
          query: string
          query_norm: string
          reason?: string | null
          snapshot?: Json | null
          source: string
        }
        Update: {
          action?: string
          created_at?: string
          id?: string
          item_id?: string
          query?: string
          query_norm?: string
          reason?: string | null
          snapshot?: Json | null
          source?: string
        }
        Relationships: []
      }
      source_runs: {
        Row: {
          count: number
          created_at: string
          error: string | null
          id: string
          search_id: string | null
          source_id: string
          status: string
          took_ms: number
        }
        Insert: {
          count?: number
          created_at?: string
          error?: string | null
          id?: string
          search_id?: string | null
          source_id: string
          status: string
          took_ms?: number
        }
        Update: {
          count?: number
          created_at?: string
          error?: string | null
          id?: string
          search_id?: string | null
          source_id?: string
          status?: string
          took_ms?: number
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      match_quote_items: {
        Args: {
          match_count?: number
          min_similarity?: number
          query_embedding: string
        }
        Returns: {
          cnpj: string
          data: string
          descricao: string
          fornecedor: string
          id: string
          orgao: string
          origem: string
          payload: Json
          query_norm: string
          search_id: string
          similarity: number
          titulo: string
          uf: string
          unidade: string
          url: string
          valor: number
          valor_total: number
        }[]
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
    }
    Enums: {
      [_ in never]: never
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
