import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Vault } from '@/database/vault.entity';

@Injectable()
export class OgService {
  private readonly logger = new Logger(OgService.name);

  constructor(
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>
  ) {}

  async getVaultOgHtml(vaultId: string, host: string): Promise<string> {
    const vault = await this.vaultsRepository.findOne({
      where: { id: vaultId },
      relations: ['vault_image', 'tags'],
    });

    if (!vault) {
      throw new NotFoundException('Vault not found');
    }

    const title = this.escapeHtml(vault.name || 'L4VA Vault');
    const fullDescription = vault.description || '';
    const truncatedDescription = fullDescription ? this.truncateText(fullDescription, 200) : '';
    const imageUrl = vault.vault_image?.file_url || '';
    const vaultUrl = `https://${host}/vaults/${vault.id}`;

    const status = vault.vault_status ? this.formatStatus(vault.vault_status) : '';

    const tvlAda = vault.total_assets_cost_ada ? this.formatNumber(Number(vault.total_assets_cost_ada)) : '0';
    const tvlUsd = vault.total_assets_cost_usd ? this.formatNumber(Number(vault.total_assets_cost_usd)) : '0';

    const ticker = vault.vault_token_ticker || '';

    const statsLine = [
      status ? `Status: ${status}` : '',
      `TVL: ₳${tvlAda} ($${tvlUsd})`,
      ticker ? `Token: $${ticker}` : '',
    ]
      .filter(Boolean)
      .join(' | ');

    const ogDescription = truncatedDescription ? `${truncatedDescription}\n${statsLine}` : statsLine;

    const tags = vault.tags?.map(t => t.name).join(', ') || '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />

  <title>${title} — L4VA</title>
  <meta name="description" content="${this.escapeAttr(ogDescription)}" />

  <!-- Open Graph -->
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${this.escapeAttr(title)}" />
  <meta property="og:description" content="${this.escapeAttr(ogDescription)}" />
  <meta property="og:url" content="${this.escapeAttr(vaultUrl)}" />
  ${imageUrl ? `<meta property="og:image" content="${this.escapeAttr(imageUrl)}" />` : ''}
  <meta property="og:site_name" content="L4VA" />

  <!-- Twitter Card -->
  <meta name="twitter:card" content="${imageUrl ? 'summary_large_image' : 'summary'}" />
  <meta name="twitter:title" content="${this.escapeAttr(title)}" />
  <meta name="twitter:description" content="${this.escapeAttr(ogDescription)}" />
  ${imageUrl ? `<meta name="twitter:image" content="${this.escapeAttr(imageUrl)}" />` : ''}

  ${tags ? `<meta name="keywords" content="${this.escapeAttr(tags)}" />` : ''}
</head>
<body>
  <h1>${title}</h1>
  ${fullDescription ? `<p>${this.escapeHtml(truncatedDescription)}</p>` : ''}
  <p>${this.escapeHtml(statsLine)}</p>
  ${imageUrl ? `<img src="${this.escapeAttr(imageUrl)}" alt="${this.escapeAttr(title)}" />` : ''}
</body>
</html>`;
  }

  private formatStatus(status: string): string {
    return status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  private formatNumber(value: number): string {
    if (value >= 1_000_000) {
      return (value / 1_000_000).toFixed(2) + 'M';
    }
    if (value >= 1_000) {
      return (value / 1_000).toFixed(2) + 'K';
    }
    return value.toFixed(2);
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  private escapeAttr(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  private truncateText(text: string, maxLength: number): string {
    if (!text || text.length <= maxLength) {
      return text;
    }
    return text.substring(0, maxLength).trim() + '...';
  }
}
