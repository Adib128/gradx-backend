import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import * as argon2 from 'argon2';
import { JwtService } from '@nestjs/jwt';
import { OAuth2Client } from 'google-auth-library';
import { LoginDto } from './dto/login.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { User, UserRole } from 'generated/prisma/browser';
import { ErrorMessageKey } from 'src/common/constants/error-message';
import { VerifyDto } from './dto/verify.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { ResponseMessageKey } from 'src/common/constants/response-message';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  ForgotPasswordDto,
  ResetPasswordDto,
  VerifyResetCodeDto,
} from './dto/forgot-password.dto';
import { withDbRetry } from 'src/common/helpers/db-retry.helper';
import { EmailService } from 'src/email/email.service';
import { EmailLanguage } from 'src/email/email.templates';
import { randomInt } from 'crypto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly googleClient: OAuth2Client;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
  ) {
    this.googleClient = new OAuth2Client();
  }

  private getGoogleClientIds(): string[] {
    const ids = [
      this.configService.get<string>('GOOGLE_CLIENT_ID'),
      this.configService.get<string>('GOOGLE_CLIENT_ID_WEB'),
      this.configService.get<string>('GOOGLE_CLIENT_ID_IOS'),
      this.configService.get<string>('GOOGLE_CLIENT_ID_ANDROID'),
      this.configService.get<string>('GOOGLE_CLIENT_ID_EXPO'),
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => value.trim());

    return Array.from(new Set(ids));
  }

  private createVerificationCode(): string {
    return randomInt(100000, 1000000).toString();
  }

  private verificationExpiry(): Date {
    return new Date(Date.now() + 10 * 60 * 1000);
  }

  private normalizeLanguage(language?: string): EmailLanguage {
    return language === 'ar' ? 'ar' : 'en';
  }

  private async sendVerificationEmail(
    email: string,
    code: string,
    language?: string,
  ) {
    try {
      await this.emailService.sendVerificationCode(
        email,
        code,
        this.normalizeLanguage(language),
      );
    } catch (error) {
      this.logger.error(
        `Verification email failed for ${email}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new InternalServerErrorException(ErrorMessageKey.EMAIL_SEND_FAILED);
    }
  }

  async register(registerDto: RegisterDto) {
    await this.checkUniqueFields({
      phone: registerDto.phone,
      email: registerDto.email,
    });

    const hash = await argon2.hash(registerDto.password);
    const verificationCode = this.createVerificationCode();
    const verificationCodeExpiresAt = this.verificationExpiry();
    const language = this.normalizeLanguage(registerDto.language);

    await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({ data: {} });
      return tx.user.create({
        data: {
          email: registerDto.email,
          passwordHash: hash,
          hashVersion: 'argon2',
          firstName: registerDto.firstName,
          lastName: registerDto.lastName,
          role: UserRole.USER,
          isActive: false,
          isVerified: false,
          phone: registerDto.phone,
          verificationCode,
          verificationCodeExpiresAt,
          tenantId: tenant.id,
          authProvider: 'LOCAL',
        },
      });
    });

    await this.sendVerificationEmail(
      registerDto.email,
      verificationCode,
      language,
    );

    return {
      message: ResponseMessageKey.REGISTER_SUCCESS,
      ...(this.emailService.exposesVerificationCode()
        ? { verificationCode }
        : {}),
    };
  }

  async resendVerification(dto: ResendVerificationDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new NotFoundException(ErrorMessageKey.USER_NOT_FOUND);
    }

    if (user.isVerified) {
      throw new ConflictException(ErrorMessageKey.USER_ALREADY_VERIFIED);
    }

    const verificationCode = this.createVerificationCode();
    const verificationCodeExpiresAt = this.verificationExpiry();

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        verificationCode,
        verificationCodeExpiresAt,
      },
    });

    await this.sendVerificationEmail(
      user.email,
      verificationCode,
      dto.language,
    );

    return {
      message: ResponseMessageKey.VERIFICATION_CODE_SENT,
      ...(this.emailService.exposesVerificationCode()
        ? { verificationCode }
        : {}),
    };
  }

  async login(
    user: User,
    meta?: { ip?: string; userAgent?: string; success?: boolean; reason?: string },
  ) {
    const payload = {
      sub: user.id,
      email: user.email,
      tid: user.tenantId,
      role: user.role,
    };

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { lastLogin: now },
      }),
      this.prisma.loginLog.create({
        data: {
          userId: user.id,
          tenantId: user.tenantId,
          email: user.email,
          ip: meta?.ip || null,
          userAgent: meta?.userAgent || null,
          success: meta?.success ?? true,
          reason: meta?.reason || null,
        },
      }),
    ]);

    return {
      access_token: await this.jwtService.signAsync(payload),
    };
  }

  async recordFailedLogin(input: {
    email: string;
    ip?: string;
    userAgent?: string;
    reason?: string;
    userId?: number;
    tenantId?: number;
  }) {
    try {
      await this.prisma.loginLog.create({
        data: {
          email: input.email,
          userId: input.userId ?? null,
          tenantId: input.tenantId ?? null,
          ip: input.ip || null,
          userAgent: input.userAgent || null,
          success: false,
          reason: input.reason || 'INVALID_CREDENTIALS',
        },
      });
    } catch {
      // Never block auth on log write failures.
    }
  }

  async validateUser(loginDto: LoginDto): Promise<User> {
    const user = await this.prisma.user.findUnique({
      where: { email: loginDto.email },
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException(ErrorMessageKey.AUTH_INVALID_CREDENTIALS);
    }

    const isPasswordValid = await argon2.verify(
      user.passwordHash,
      loginDto.password,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException(ErrorMessageKey.AUTH_INVALID_CREDENTIALS);
    }

    if (!user.isActive) {
      throw new UnauthorizedException(ErrorMessageKey.ACCOUNT_DISABLED);
    }

    return user;
  }

  async loginWithGoogle(googleLoginDto: GoogleLoginDto) {
    const audience = this.getGoogleClientIds();
    if (audience.length === 0) {
      throw new UnauthorizedException(ErrorMessageKey.AUTH_INVALID_CREDENTIALS);
    }

    let payload: {
      sub?: string;
      email?: string;
      email_verified?: boolean | string;
      given_name?: string;
      family_name?: string;
      name?: string;
    };

    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken: googleLoginDto.idToken,
        audience,
      });
      payload = ticket.getPayload() || {};
    } catch {
      throw new UnauthorizedException(ErrorMessageKey.AUTH_INVALID_CREDENTIALS);
    }

    const googleId = payload.sub;
    const email = payload.email?.toLowerCase().trim();
    const emailVerified =
      payload.email_verified === true || payload.email_verified === 'true';

    if (!googleId || !email || !emailVerified) {
      throw new UnauthorizedException(ErrorMessageKey.AUTH_INVALID_CREDENTIALS);
    }

    const firstName =
      payload.given_name ||
      payload.name?.split(' ')?.[0] ||
      null;
    const lastName =
      payload.family_name ||
      payload.name?.split(' ')?.slice(1).join(' ') ||
      null;

    let user = await this.prisma.user.findFirst({
      where: {
        OR: [{ googleId }, { email }],
      },
    });

    if (!user) {
      user = await this.prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({ data: {} });
        return tx.user.create({
          data: {
            email,
            googleId,
            authProvider: 'GOOGLE',
            passwordHash: null,
            hashVersion: null,
            firstName,
            lastName,
            role: UserRole.USER,
            isActive: true,
            isVerified: true,
            tenantId: tenant.id,
            lastLogin: new Date(),
          },
        });
      });
    } else {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          googleId: user.googleId || googleId,
          authProvider: user.passwordHash ? user.authProvider : 'GOOGLE',
          isVerified: true,
          isActive: true,
          firstName: user.firstName || firstName,
          lastName: user.lastName || lastName,
          lastLogin: new Date(),
        },
      });
    }

    return this.login(user);
  }

  async verify(verifyDto: VerifyDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: verifyDto.email },
    });

    if (!user) {
      throw new NotFoundException(ErrorMessageKey.USER_NOT_FOUND);
    }

    if (user.isVerified) {
      throw new ConflictException(ErrorMessageKey.USER_ALREADY_VERIFIED);
    }

    if (!user.verificationCode || !user.verificationCodeExpiresAt) {
      throw new UnauthorizedException(
        ErrorMessageKey.INVALID_VERIFICATION_CODE,
      );
    }

    if (user.verificationCodeExpiresAt < new Date()) {
      throw new UnauthorizedException(
        ErrorMessageKey.VERIFICATION_CODE_EXPIRED,
      );
    }

    if (user.verificationCode != verifyDto.code) {
      throw new UnauthorizedException(
        ErrorMessageKey.INVALID_VERIFICATION_CODE,
      );
    }
    const updatedUser = await this.prisma.user.update({
      where: { email: verifyDto.email },
      data: {
        isVerified: true,
        isActive: true,
        verificationCode: null,
        verificationCodeExpiresAt: null,
      },
    });
    return this.login(updatedUser);
  }

  async changePassword(userId: number, changePasswordDto: ChangePasswordDto) {
    const { currentPassword, newPassword } = changePasswordDto;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.passwordHash) {
      throw new NotFoundException(ErrorMessageKey.USER_NOT_FOUND);
    }

    const isCurrentPasswordValid = await argon2.verify(
      user.passwordHash,
      currentPassword,
    );

    if (!isCurrentPasswordValid) {
      throw new UnauthorizedException(ErrorMessageKey.AUTH_INVALID_CREDENTIALS);
    }

    const isSamePassword = await argon2.verify(user.passwordHash, newPassword);

    if (isSamePassword) {
      throw new ConflictException(ErrorMessageKey.PASSWORD_SAME_AS_OLD);
    }

    const newPasswordHash = await argon2.hash(newPassword);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: newPasswordHash,
      },
    });
    return {
      message: ResponseMessageKey.CHANGE_PASSWORD_SUCCESS,
    };
  }

  private async findUserForPasswordReset(dto: {
    email?: string;
    phone?: string;
  }) {
    if (dto.email) {
      return this.prisma.user.findUnique({ where: { email: dto.email } });
    }
    if (dto.phone) {
      return this.prisma.user.findFirst({
        where: {
          OR: [{ phone: dto.phone }, { phone: dto.phone.replace(/\s+/g, '') }],
        },
      });
    }
    return null;
  }

  private assertResetCode(user: User, code: string) {
    if (!user.verificationCode || !user.verificationCodeExpiresAt) {
      throw new UnauthorizedException(
        ErrorMessageKey.INVALID_VERIFICATION_CODE,
      );
    }
    if (user.verificationCodeExpiresAt < new Date()) {
      throw new UnauthorizedException(
        ErrorMessageKey.VERIFICATION_CODE_EXPIRED,
      );
    }
    if (user.verificationCode !== code) {
      throw new UnauthorizedException(
        ErrorMessageKey.INVALID_VERIFICATION_CODE,
      );
    }
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.findUserForPasswordReset(dto);
    if (!user) {
      throw new NotFoundException(ErrorMessageKey.USER_NOT_FOUND);
    }
    if (!user.passwordHash) {
      throw new BadRequestException(
        'Password reset is not available for this account',
      );
    }

    const verificationCode = this.createVerificationCode();
    const verificationCodeExpiresAt = this.verificationExpiry();
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        verificationCode,
        verificationCodeExpiresAt,
      },
    });

    if (user.email) {
      await this.sendVerificationEmail(
        user.email,
        verificationCode,
        dto.language,
      );
    }

    return {
      message: ResponseMessageKey.VERIFICATION_CODE_SENT,
      ...(this.emailService.exposesVerificationCode()
        ? { verificationCode }
        : {}),
    };
  }

  async verifyResetCode(dto: VerifyResetCodeDto) {
    const user = await this.findUserForPasswordReset(dto);
    if (!user) {
      throw new NotFoundException(ErrorMessageKey.USER_NOT_FOUND);
    }
    this.assertResetCode(user, dto.code);
    return { valid: true };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.findUserForPasswordReset(dto);
    if (!user || !user.passwordHash) {
      throw new NotFoundException(ErrorMessageKey.USER_NOT_FOUND);
    }
    this.assertResetCode(user, dto.code);

    const isSamePassword = await argon2.verify(
      user.passwordHash,
      dto.newPassword,
    );
    if (isSamePassword) {
      throw new ConflictException(ErrorMessageKey.PASSWORD_SAME_AS_OLD);
    }

    const newPasswordHash = await argon2.hash(dto.newPassword);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: newPasswordHash,
        verificationCode: null,
        verificationCodeExpiresAt: null,
        isVerified: true,
        isActive: true,
      },
    });

    return {
      message: ResponseMessageKey.CHANGE_PASSWORD_SUCCESS,
    };
  }

  async updateProfile(userId: number, updateProfileDto: UpdateProfileDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(ErrorMessageKey.USER_NOT_FOUND);
    }
    await this.checkUniqueFields({
      phone: updateProfileDto.phone,
      email: updateProfileDto.email,
    });

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: updateProfileDto,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
      },
    });
    return {
      message: ResponseMessageKey.USER_UPDATED_SUCCESS,
      user: updatedUser,
    };
  }

  private async checkUniqueFields({
    phone,
    email,
  }: {
    phone?: string;
    email?: string;
  }) {
    const [phoneExists, emailExists] = await Promise.all([
      phone ? this.prisma.user.findUnique({ where: { phone } }) : null,
      email ? this.prisma.user.findUnique({ where: { email } }) : null,
    ]);

    if (phoneExists)
      throw new ConflictException(ErrorMessageKey.PHONE_ALREADY_EXISTS);

    if (emailExists)
      throw new ConflictException(ErrorMessageKey.EMAIL_ALREADY_EXISTS);
  }

  async findById(userId: number): Promise<User> {
    const user = await withDbRetry(() =>
      this.prisma.user.findUnique({
        where: { id: userId },
      }),
    );
    if (!user) {
      throw new NotFoundException(ErrorMessageKey.USER_NOT_FOUND);
    }
    return user;
  }
}
