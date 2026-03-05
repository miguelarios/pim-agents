import { type CardDavConfig, ConnectionError, toPimError } from "@miguelarios/pim-core";
import { DAVClient } from "tsdav";

export interface AddressBook {
  displayName: string;
  url: string;
  ctag?: string;
}

export class CardDavService {
  private client: DAVClient | null = null;
  private config: CardDavConfig;

  constructor(config: CardDavConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      this.client = new DAVClient({
        serverUrl: this.config.url,
        credentials: {
          username: this.config.username,
          password: this.config.password,
        },
        authMethod: "Basic",
        defaultAccountType: "carddav",
      });
      await this.client.login();
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async ensureConnected(): Promise<DAVClient> {
    if (!this.client) {
      await this.connect();
    }
    if (!this.client) {
      throw new ConnectionError("Failed to establish CardDAV connection");
    }
    return this.client;
  }

  async listAddressBooks(): Promise<AddressBook[]> {
    const client = await this.ensureConnected();
    try {
      const books = await client.fetchAddressBooks();
      return books.map((book) => ({
        displayName: book.displayName ?? "",
        url: book.url,
        ctag: book.ctag,
      }));
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async disconnect(): Promise<void> {
    this.client = null;
  }
}
