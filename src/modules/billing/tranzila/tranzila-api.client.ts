import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../../config/config.service';
import { buildTranzilaAuthHeaders } from './tranzila-auth.util';

const PAYMENTS_BASE = 'https://api.tranzila.com';
const REQUEST_TIMEOUT_MS = 20_000;

export interface TranzilaV2ChargeInput {
  terminalName: string;
  token: string;
  sum: number;
  itemName: string;
  expireMonth: number;
  expireYear: number;
}

export interface TranzilaV2ChargeResult {
  ok: boolean;
  errorCode: number;
  message: string;
  processorResponseCode: string;
  transactionId: string | null;
  authNumber: string | null;
  last4: string | null;
  raw: unknown;
}

interface TranzilaV2ChargeResponse {
  error_code?: number;
  message?: string;
  transaction_result?: {
    processor_response_code?: string;
    transaction_id?: string;
    auth_number?: string;
    last_4?: string;
  };
}

@Injectable()
export class TranzilaApiClient {
  private readonly logger = new Logger(TranzilaApiClient.name);

  constructor(private readonly config: AppConfigService) {}

  assertConfigured(): void {
    if (!this.config.get('TRANZILA_PUBLIC_KEY') || !this.config.get('TRANZILA_PRIVATE_KEY')) {
      throw new BadGatewayException(
        'Tranzila API keys missing. Set TRANZILA_PUBLIC_KEY and TRANZILA_PRIVATE_KEY.',
      );
    }
  }

  /** Charge a stored TranzilaTK via POST /v1/transaction/credit_card/create. */
  async chargeWithToken(input: TranzilaV2ChargeInput): Promise<TranzilaV2ChargeResult> {
    this.assertConfigured();
    const publicKey = this.config.require('TRANZILA_PUBLIC_KEY');
    const privateKey = this.config.require('TRANZILA_PRIVATE_KEY');

    const body = {
      terminal_name: input.terminalName,
      txn_type: 'debit',
      items: [
        {
          name: input.itemName,
          type: 'I',
          unit_price: input.sum,
          currency_code: 'ILS',
          units_number: 1,
        },
      ],
      card_number: input.token,
      expire_month: input.expireMonth,
      expire_year: input.expireYear,
      cvv: '000',
    };

    const auth = buildTranzilaAuthHeaders(publicKey, privateKey);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...auth,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let parsed: TranzilaV2ChargeResponse;
    try {
      const response = await fetch(
        `${PAYMENTS_BASE}/v1/transaction/credit_card/create`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );

      const text = await response.text();
      try {
        parsed = JSON.parse(text) as TranzilaV2ChargeResponse;
      } catch {
        this.logger.error(`Tranzila V2 non-JSON status=${response.status} body=${text.slice(0, 300)}`);
        throw new BadGatewayException('Tranzila returned an invalid response');
      }

      if (!response.ok) {
        throw new BadGatewayException(
          parsed.message ?? `Tranzila V2 HTTP ${response.status}`,
        );
      }
    } catch (err) {
      if (err instanceof BadGatewayException) throw err;
      const detail =
        err instanceof Error && err.name === 'AbortError'
          ? `timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
          : err instanceof Error
            ? err.message
            : String(err);
      throw new BadGatewayException(`Tranzila V2 charge failed: ${detail}`);
    } finally {
      clearTimeout(timeout);
    }

    const processorCode = parsed.transaction_result?.processor_response_code ?? '';
    const ok =
      parsed.error_code === 0 &&
      processorCode === '000';

    const result: TranzilaV2ChargeResult = {
      ok,
      errorCode: parsed.error_code ?? -1,
      message: parsed.message ?? '',
      processorResponseCode: processorCode,
      transactionId: parsed.transaction_result?.transaction_id ?? null,
      authNumber: parsed.transaction_result?.auth_number ?? null,
      last4: parsed.transaction_result?.last_4 ?? null,
      raw: parsed,
    };

    this.logger.log(
      `v2-charge terminal=${input.terminalName} sum=${input.sum} ` +
        `ok=${ok} processor=${processorCode || '<empty>'} ` +
        `txn=${result.transactionId ?? '-'}`,
    );

    return result;
  }
}
