import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminGuard } from '@/modules/auth/admin.guard';

import { FTPricingSource, FTPricingStrategyService, PolicyPricingRule } from './ft-pricing-strategy.service';

class AddPolicyRuleDto {
  policyId: string;
  source: FTPricingSource;
  poolId?: string;
  description?: string;
}

class TestPriceDto {
  tokenUnit: string;
}

/**
 * FT Pricing Strategy Admin Controller
 *
 * Endpoints for managing FT pricing configuration:
 * - View current default source and policy rules
 * - Add/update/delete policy-specific pricing rules
 * - Test pricing for specific tokens
 *
 * All endpoints require admin authentication
 */
@ApiTags('Admin - FT Pricing Strategy')
@Controller('admin/ft-pricing-strategy')
@UseGuards(AdminGuard)
export class FTPricingStrategyController {
  constructor(private readonly ftPricingStrategy: FTPricingStrategyService) {}

  /**
   * Get current FT pricing strategy configuration
   */
  @Get('config')
  @ApiOperation({ summary: 'Get FT pricing strategy configuration' })
  getConfig() {
    return this.ftPricingStrategy.getDiagnostics();
  }

  /**
   * Get all policy-specific pricing rules
   */
  @Get('rules')
  @ApiOperation({ summary: 'Get all policy pricing rules' })
  getRules(): PolicyPricingRule[] {
    return this.ftPricingStrategy.getPolicyRules();
  }

  /**
   * Add or update a policy-specific pricing rule
   */
  @Post('rules')
  @ApiOperation({ summary: 'Add or update a policy pricing rule' })
  addRule(@Body() dto: AddPolicyRuleDto) {
    this.ftPricingStrategy.updatePolicyRule(dto.policyId, dto.source, dto.poolId, dto.description);
    return {
      success: true,
      message: `Policy rule added/updated for ${dto.policyId}`,
      rule: dto,
    };
  }

  /**
   * Update an existing policy pricing rule
   */
  @Put('rules/:policyId')
  @ApiOperation({ summary: 'Update a policy pricing rule' })
  updateRule(@Param('policyId') policyId: string, @Body() dto: Omit<AddPolicyRuleDto, 'policyId'>) {
    this.ftPricingStrategy.updatePolicyRule(policyId, dto.source, dto.poolId, dto.description);
    return {
      success: true,
      message: `Policy rule updated for ${policyId}`,
      rule: { policyId, ...dto },
    };
  }

  /**
   * Delete a policy pricing rule
   */
  @Delete('rules/:policyId')
  @ApiOperation({ summary: 'Delete a policy pricing rule' })
  deleteRule(@Param('policyId') policyId: string) {
    this.ftPricingStrategy.removePolicyRule(policyId);
    return {
      success: true,
      message: `Policy rule deleted for ${policyId}`,
    };
  }

  /**
   * Test pricing for a specific token
   * Returns price from configured strategy and details about which source was used
   */
  @Post('test')
  @ApiOperation({ summary: 'Test pricing for a specific token' })
  async testPrice(@Body() dto: TestPriceDto) {
    const price = await this.ftPricingStrategy.getTokenPrice(dto.tokenUnit);
    const policyId = dto.tokenUnit.slice(0, 56);
    const rules = this.ftPricingStrategy.getPolicyRules();
    const rule = rules.find(r => r.policyId === policyId);

    return {
      tokenUnit: dto.tokenUnit,
      policyId,
      price,
      priceUnavailable: price === null,
      usedPolicyRule: rule !== undefined,
      policyRule: rule || null,
      defaultSource: this.ftPricingStrategy.getDefaultSource(),
    };
  }

  /**
   * Batch test pricing for multiple tokens
   */
  @Post('test-batch')
  @ApiOperation({ summary: 'Test pricing for multiple tokens' })
  async testBatchPrice(@Body() dto: { tokenUnits: string[] }) {
    const prices = await this.ftPricingStrategy.getTokenPrices(dto.tokenUnits);
    const results = [];

    for (const tokenUnit of dto.tokenUnits) {
      const price = prices.get(tokenUnit);
      const policyId = tokenUnit.slice(0, 56);
      const rules = this.ftPricingStrategy.getPolicyRules();
      const rule = rules.find(r => r.policyId === policyId);

      results.push({
        tokenUnit,
        policyId,
        price,
        priceUnavailable: price === null,
        usedPolicyRule: rule !== undefined,
        policyRule: rule || null,
      });
    }

    return {
      results,
      defaultSource: this.ftPricingStrategy.getDefaultSource(),
      totalTokens: dto.tokenUnits.length,
      foundPrices: results.filter(r => r.price !== null).length,
    };
  }
}
