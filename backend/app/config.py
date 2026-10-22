from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "sqlite:///./data/orbit.db"
    cors_origins: str = "http://localhost:5173,http://localhost:8080"
    webrtc_ice_servers: str = '[{"urls":["stun:stun.l.google.com:19302"]}]'

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def webrtc_ice_server_list(self) -> list[dict]:
        import json

        try:
            value = json.loads(self.webrtc_ice_servers)
        except json.JSONDecodeError as error:
            raise ValueError("WEBRTC_ICE_SERVERS musí být platný JSON.") from error
        if not isinstance(value, list) or not all(isinstance(server, dict) for server in value):
            raise ValueError("WEBRTC_ICE_SERVERS musí být JSON pole ICE serverů.")
        return value


settings = Settings()
