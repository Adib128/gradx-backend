import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import * as argon2 from 'argon2';
import { JwtService } from '@nestjs/jwt';
import { LoginDto } from './dto/login.dto';
import { User, UserRole } from 'generated/prisma/browser';
import { ErrorMessageKey } from 'src/common/constants/error-message';
import { VerifyDto } from './dto/verify.dto';
import { ResponseMessageKey } from 'src/common/constants/response-message';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async register(registerDto: RegisterDto) {
    console.log(registerDto);
    await this.checkUniqueFields({
      phone: registerDto.phone,
      email: registerDto.email,
    });

    const hash = await argon2.hash(registerDto.password);
    //const verificationCode = randomInt(100000, 999999).toString();
    const verificationCode = '123456';
    const verificationCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

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
        },
      });
    });
    return {
      message: ResponseMessageKey.REGISTER_SUCCESS,
      verificationCode,
    };
  }

  async login(user: User) {
    const payload = {
      sub: user.id,
      email: user.email,
      tid: user.tenantId,
    };
    return {
      access_token: await this.jwtService.signAsync(payload),
    };
  }

  async validateUser(loginDto: LoginDto): Promise<User> {
    const user = await this.prisma.user.findUnique({
      where: { email: loginDto.email },
    });

    if (!user) {
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

    if (!user) {
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
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException(ErrorMessageKey.USER_NOT_FOUND);
    }
    return user;
  }
}
